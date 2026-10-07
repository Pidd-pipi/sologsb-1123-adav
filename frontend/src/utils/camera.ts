import type { CameraPreset, Mission } from '../types/mission';
import { isCameraLockedStatus } from '../types/mission';

/** 一个相机预设族（同一 familyId 的全部只追加修订） */
export interface PresetFamily {
  familyId: string;
  /** 修订按修订号升序 */
  revisions: CameraPreset[];
  latest: CameraPreset;
}

/** 把扁平的修订行按族聚合 */
export function groupPresets(rows: CameraPreset[]): PresetFamily[] {
  const map = new Map<string, CameraPreset[]>();
  rows.forEach((p) => {
    const list = map.get(p.familyId) ?? [];
    list.push(p);
    map.set(p.familyId, list);
  });
  return [...map.entries()].map(([familyId, list]) => {
    const revisions = list.sort((a, b) => a.revision - b.revision);
    return { familyId, revisions, latest: revisions[revisions.length - 1] };
  });
}

export function revisionsOfFamily(rows: CameraPreset[], familyId: string): CameraPreset[] {
  return rows
    .filter((p) => p.familyId === familyId)
    .sort((a, b) => a.revision - b.revision);
}

export interface MissionCameraState {
  /** 是否绑定了相机预设族 */
  bound: boolean;
  /** 任务当前锁定/跟随的修订号 */
  currentRevision: number;
  /** 族内最新修订（未绑定时为 undefined） */
  latest?: CameraPreset;
  /** 已飞/归档：相机参数锁定，不随新修订变化 */
  locked: boolean;
  /** 规划中/待飞：绑定族已有更新的修订，任务尚未追上 */
  outdated: boolean;
}

/** 计算任务相机参数与预设修订的关系，供台账标注「修订 / 是否落后」 */
export function missionCameraState(mission: Mission, presets: CameraPreset[]): MissionCameraState {
  const currentRevision = mission.presetRevision ?? 0;
  const family = mission.presetId ? revisionsOfFamily(presets, mission.presetId) : [];
  const latest = family[family.length - 1];
  const locked = isCameraLockedStatus(mission.status);
  const bound = !!mission.presetId && family.length > 0;
  return {
    bound,
    currentRevision,
    latest,
    locked,
    outdated: bound && !locked && latest.revision > currentRevision,
  };
}
