import { LOCKED_STATUSES, type CameraPreset, type Mission } from '../types/mission';

/** 某系列下按修订号升序排列的全部修订（只追加、不覆盖） */
export function revisionsOf(presets: CameraPreset[], seriesId: string): CameraPreset[] {
  return presets
    .filter((p) => p.seriesId === seriesId)
    .sort((a, b) => a.revision - b.revision);
}

/** 某系列的最新修订 */
export function latestRevision(presets: CameraPreset[], seriesId: string): CameraPreset | undefined {
  const list = revisionsOf(presets, seriesId);
  return list[list.length - 1];
}

/**
 * 飞行日期当时生效的修订：effectiveAt 已生效（按日期当天末刻判定）中的最新一条；
 * 一条都没有时退化为最早修订，保证历史任务总能归到某条旧修订。
 */
export function revisionAtFlightDate(presets: CameraPreset[], seriesId: string, flightDate: string): CameraPreset | undefined {
  const list = revisionsOf(presets, seriesId);
  if (list.length === 0) return undefined;
  const endOfFlightDay = flightDate ? new Date(`${flightDate}T23:59:59`).getTime() : Number.POSITIVE_INFINITY;
  const effective = list.filter((p) => !Number.isFinite(endOfFlightDay) || p.effectiveAt <= endOfFlightDay);
  return effective[effective.length - 1] ?? list[0];
}

/** 任务当前参数所锁定的那条修订 */
export function missionRevision(presets: CameraPreset[], mission: Mission): CameraPreset | undefined {
  if (!mission.presetSeriesId) return undefined;
  return presets.find((p) => p.seriesId === mission.presetSeriesId && p.revision === mission.presetRevision);
}

/** 已飞 / 已归档：参数冻结在飞行时修订上，不再跟随 */
export function isRevisionLocked(mission: Mission): boolean {
  return LOCKED_STATUSES.includes(mission.status);
}

/** 预设名（无修订记录时回退到任务上的相机型号） */
export function presetNameOf(presets: CameraPreset[], mission: Mission): string {
  return missionRevision(presets, mission)?.name ?? latestRevision(presets, mission.presetSeriesId ?? '')?.name ?? '';
}

/**
 * 是否落后于最新修订：仅未锁定（规划中 / 待飞行）且关联了预设系列、
 * 锁定修订号小于系列最新修订号时为 true。写入失败留下的旧修订也会在这里暴露，供重试。
 */
export function isMissionStale(presets: CameraPreset[], mission: Mission): boolean {
  if (!mission.presetSeriesId || isRevisionLocked(mission)) return false;
  const latest = latestRevision(presets, mission.presetSeriesId);
  return !!latest && latest.revision > (mission.presetRevision || 0);
}
