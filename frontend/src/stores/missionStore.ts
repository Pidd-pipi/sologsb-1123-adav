import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { isRevisionLocked, latestRevision, revisionsOf } from '../utils/presetRevisions';
import type {
  CameraPreset,
  CameraPresetDraft,
  CameraPresetPatch,
  Mission,
  MissionDraft,
  MissionStatus,
} from '../types/mission';

/** 把修订的相机参数铺到任务快照上（GSD/航线间距/预计张数/架次由这些快照重算） */
function snapshotFromRevision(m: Mission, rev: CameraPreset): Partial<Mission> {
  return {
    cameraModel: rev.cameraModel,
    sensorWidth: rev.sensorWidth,
    sensorHeight: rev.sensorHeight,
    focalLength: rev.focalLength,
    pixelSize: rev.pixelSize,
    presetSeriesId: rev.seriesId,
    presetRevision: rev.revision,
  };
}

interface MissionState {
  items: Mission[];
  presets: CameraPreset[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: MissionDraft) => Promise<Mission>;
  update: (id: string, patch: Partial<Mission>) => Promise<void>;
  setStatus: (id: string, status: MissionStatus) => Promise<void>;
  applyPreset: (missionId: string, seriesId: string) => Promise<void>;
  syncMission: (missionId: string) => Promise<void>;
  syncAllStale: () => Promise<number>;
  addPreset: (draft: CameraPresetDraft) => Promise<CameraPreset>;
  /** 改参数只追加一条新修订，并在同一事务内传播到所有未锁定（规划中/待飞行）任务；
   *  事务任一步失败整体回滚，旧修订原样保留，可重试 */
  revisePreset: (seriesId: string, patch: CameraPresetPatch) => Promise<CameraPreset>;
  removePreset: (seriesId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  items: [],
  presets: [],
  loaded: false,
  async load() {
    const rows = await db.missions.orderBy('createdAt').reverse().toArray();
    const presets = (await db.presets.toArray()).sort((a, b) =>
      a.seriesId === b.seriesId ? a.revision - b.revision : a.seriesId.localeCompare(b.seriesId),
    );
    set({ items: rows, presets, loaded: true });
  },
  async add(draft) {
    const record: Mission = { ...draft, id: newId('mission'), createdAt: Date.now() };
    await db.missions.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch) {
    await db.missions.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async setStatus(id, status) {
    const mission = get().items.find((m) => m.id === id);
    if (!mission || mission.status === status) return;
    const wasLocked = isRevisionLocked(mission);
    const becomesLocked = isRevisionLocked({ ...mission, status });
    if (!wasLocked && becomesLocked) {
      // 转为已飞/已归档：先同步到当前最新修订，再以该修订为“飞行时修订”锁定
      const latest = mission.presetSeriesId ? latestRevision(get().presets, mission.presetSeriesId) : undefined;
      const patch: Partial<Mission> = latest
        ? { status, ...snapshotFromRevision(mission, latest) }
        : { status };
      await db.missions.update(id, patch);
      set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
      return;
    }
    if (wasLocked && !becomesLocked) {
      // 解锁回规划：跟随最新修订（原锁定修订仍保留在 presets 历史中）
      const latest = mission.presetSeriesId ? latestRevision(get().presets, mission.presetSeriesId) : undefined;
      const patch: Partial<Mission> = latest
        ? { status, ...snapshotFromRevision(mission, latest) }
        : { status };
      await db.missions.update(id, patch);
      set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
      return;
    }
    await get().update(id, { status });
  },
  async applyPreset(missionId, seriesId) {
    const mission = get().items.find((m) => m.id === missionId);
    const latest = latestRevision(get().presets, seriesId);
    if (!mission || !latest) return;
    if (isRevisionLocked(mission)) {
      throw new Error('已飞/已归档任务锁在飞行时的修订上，不能再带入新预设');
    }
    await get().update(missionId, snapshotFromRevision(mission, latest));
  },
  /** 写入失败后重试：把单个未锁定任务拉到其系列最新修订 */
  async syncMission(missionId) {
    const mission = get().items.find((m) => m.id === missionId);
    if (!mission || !mission.presetSeriesId || isRevisionLocked(mission)) return;
    const latest = latestRevision(get().presets, mission.presetSeriesId);
    if (!latest || latest.revision === mission.presetRevision) return;
    await db.missions.update(missionId, snapshotFromRevision(mission, latest));
    set({ items: get().items.map((it) => (it.id === missionId ? { ...it, ...snapshotFromRevision(it, latest) } : it)) });
  },
  /** 一键重试：把全部落后的未锁定任务同步到最新修订，返回同步条数 */
  async syncAllStale() {
    const { presets } = get();
    const stale = get().items.filter((m) => {
      if (!m.presetSeriesId || isRevisionLocked(m)) return false;
      const latest = latestRevision(presets, m.presetSeriesId);
      return !!latest && latest.revision > m.presetRevision;
    });
    await Promise.all(stale.map((m) => get().syncMission(m.id)));
    return stale.length;
  },
  async addPreset(draft) {
    const seriesId = newId('series');
    const record: CameraPreset = {
      ...draft,
      id: newId('preset'),
      seriesId,
      revision: 1,
      effectiveAt: Date.now(),
    };
    await db.presets.put(record);
    set({ presets: [...get().presets, record] });
    return record;
  },
  async revisePreset(seriesId, patch) {
    const list = revisionsOf(get().presets, seriesId);
    const current = list[list.length - 1];
    if (!current) throw new Error('预设系列不存在');
    const nextRev: CameraPreset = {
      ...current,
      ...patch,
      id: newId('preset'),
      seriesId,
      revision: current.revision + 1,
      effectiveAt: Date.now(),
    };
    // 追加新修订 + 传播到规划中/待飞行任务在同一事务内：写入失败整体回滚，旧修订不动，可重试
    await db.transaction('rw', [db.presets, db.missions], async () => {
      await db.presets.put(nextRev);
      const followers = await db.missions
        .where('presetSeriesId')
        .equals(seriesId)
        .filter((m) => !isRevisionLocked(m))
        .toArray();
      for (const m of followers) {
        await db.missions.update(m.id, snapshotFromRevision(m, nextRev));
      }
    });
    set((state) => ({
      presets: [...state.presets, nextRev],
      items: state.items.map((m) =>
        m.presetSeriesId === seriesId && !isRevisionLocked(m) ? { ...m, ...snapshotFromRevision(m, nextRev) } : m,
      ),
    }));
    return nextRev;
  },
  async removePreset(seriesId) {
    const used = get().items.some((m) => m.presetSeriesId === seriesId);
    if (used) {
      throw new Error('该预设已被任务引用（含历史修订），不能删除');
    }
    const ids = revisionsOf(get().presets, seriesId).map((p) => p.id);
    await db.presets.bulkDelete(ids);
    set({ presets: get().presets.filter((p) => p.seriesId !== seriesId) });
  },
  async remove(id) {
    await db.missions.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
