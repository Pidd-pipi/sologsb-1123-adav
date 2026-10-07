import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { revisionsOfFamily } from '../utils/camera';
import {
  isCameraLockedStatus,
  type CameraPreset,
  type CameraPresetDraft,
  type Mission,
  type MissionDraft,
  type MissionStatus,
} from '../types/mission';

/** 修订携带的相机参数快照（写入任务，飞行后即冻结） */
function presetSnapshot(p: CameraPreset) {
  return {
    cameraModel: p.cameraModel,
    sensorWidth: p.sensorWidth,
    sensorHeight: p.sensorHeight,
    focalLength: p.focalLength,
    pixelSize: p.pixelSize,
  };
}

export interface ReviseResult {
  revision: CameraPreset;
  /** 追赶新修订时写入失败的任务（旧修订保留，可在台账重试） */
  failedMissionIds: string[];
}

interface MissionState {
  items: Mission[];
  /** 全部预设修订行（扁平，按族 + 修订号用工具聚合） */
  presets: CameraPreset[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: MissionDraft) => Promise<Mission>;
  update: (id: string, patch: Partial<Mission>) => Promise<void>;
  setStatus: (id: string, status: MissionStatus) => Promise<void>;
  /** 把预设族的最新修订带入未锁定任务；已飞/归档任务拒绝带入 */
  applyPreset: (missionId: string, familyId: string) => Promise<void>;
  /** 新建预设族（第 1 修订） */
  addPreset: (draft: CameraPresetDraft) => Promise<CameraPreset>;
  /** 改参数 = 只追加一个新修订，旧修订永不覆盖；随后追赶规划中/待飞任务 */
  revisePreset: (familyId: string, draft: CameraPresetDraft) => Promise<ReviseResult>;
  /** 单个规划中/待飞任务追赶到族内最新修订；写入失败时抛出，旧修订保留可重试 */
  catchupMission: (id: string) => Promise<void>;
  /** 删除未被任何任务引用的预设族（整族修订一起删） */
  removePresetFamily: (familyId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  items: [],
  presets: [],
  loaded: false,

  async load() {
    const rows = await db.missions.orderBy('createdAt').reverse().toArray();
    const presets = await db.presets.toArray();
    set({ items: rows, presets, loaded: true });
    // 规划中/待飞任务打开即跟最新修订；逐条追赶，单条写失败不影响其他任务，旧修订保留
    for (const mission of rows) {
      if (isCameraLockedStatus(mission.status)) continue;
      try {
        await get().catchupMission(mission.id);
      } catch {
        /* 保留旧修订，台账提供重试 */
      }
    }
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
    await get().update(id, { status });
    // 从已飞/归档退回规划中时立即追赶最新修订；进入已飞/归档则保持当前修订不变（锁定）
    if (!isCameraLockedStatus(status)) {
      try {
        await get().catchupMission(id);
      } catch {
        /* 保留当前修订，可稍后重试 */
      }
    }
  },

  async applyPreset(missionId, familyId) {
    const mission = get().items.find((m) => m.id === missionId);
    if (!mission) return;
    if (isCameraLockedStatus(mission.status)) {
      throw new Error('已飞行 / 已归档任务的相机参数已锁定，不能再带入其他预设');
    }
    const family = revisionsOfFamily(get().presets, familyId);
    const latest = family[family.length - 1];
    if (!latest) throw new Error('未找到该相机预设修订');
    const patch: Partial<Mission> = {
      presetId: familyId,
      presetRevision: latest.revision,
      ...presetSnapshot(latest),
    };
    await db.missions.update(missionId, patch);
    set({ items: get().items.map((it) => (it.id === missionId ? { ...it, ...patch } : it)) });
  },

  async addPreset(draft) {
    const record: CameraPreset = {
      ...draft,
      id: newId('preset'),
      familyId: newId('preset-family'),
      revision: 1,
      createdAt: Date.now(),
    };
    // 只追加写入：失败时表内旧修订原样保留，可重试
    await db.presets.put(record);
    set({ presets: [...get().presets, record] });
    return record;
  },

  async revisePreset(familyId, draft) {
    const family = revisionsOfFamily(get().presets, familyId);
    if (family.length === 0) throw new Error('未找到要修订的相机预设');
    const record: CameraPreset = {
      ...draft,
      id: newId('preset'),
      familyId,
      revision: family[family.length - 1].revision + 1,
      createdAt: Date.now(),
    };
    // 新修订独立追加落库：即便后续任务追赶失败，旧修订与新修订都还在，可重试追赶
    await db.presets.put(record);
    set({ presets: [...get().presets, record] });

    const failedMissionIds: string[] = [];
    for (const mission of get().items) {
      if (mission.presetId !== familyId || isCameraLockedStatus(mission.status)) continue;
      try {
        await get().catchupMission(mission.id);
      } catch {
        failedMissionIds.push(mission.id);
      }
    }
    return { revision: record, failedMissionIds };
  },

  async catchupMission(id) {
    const mission = get().items.find((m) => m.id === id);
    if (!mission || !mission.presetId || isCameraLockedStatus(mission.status)) return;
    const family = revisionsOfFamily(get().presets, mission.presetId);
    const latest = family[family.length - 1];
    if (!latest) return;
    if (
      mission.presetRevision === latest.revision &&
      mission.focalLength === latest.focalLength &&
      mission.pixelSize === latest.pixelSize &&
      mission.sensorWidth === latest.sensorWidth &&
      mission.sensorHeight === latest.sensorHeight &&
      mission.cameraModel === latest.cameraModel
    ) {
      return;
    }
    const patch: Partial<Mission> = { presetRevision: latest.revision, ...presetSnapshot(latest) };
    // 写入失败直接抛出：库内仍是旧修订行与旧任务快照，下次可重试
    await db.missions.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },

  async removePresetFamily(familyId) {
    const used = get().items.some((m) => m.presetId === familyId);
    if (used) throw new Error('该预设已被任务引用，不能删除；需要调整参数请发布新修订');
    const ids = get()
      .presets.filter((p) => p.familyId === familyId)
      .map((p) => p.id);
    await db.presets.bulkDelete(ids);
    set({ presets: get().presets.filter((p) => p.familyId !== familyId) });
  },

  async remove(id) {
    await db.missions.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
