/** 航拍用途 */
export type MissionPurpose = '正射' | '倾斜' | '带状';

export const MISSION_PURPOSES: MissionPurpose[] = ['正射', '倾斜', '带状'];

export type MissionStatus = '规划中' | '待飞行' | '已飞行' | '已归档';

export const MISSION_STATUSES: MissionStatus[] = ['规划中', '待飞行', '已飞行', '已归档'];

/** 已飞行 / 已归档的任务锁定相机参数，规划中 / 待飞行 跟最新修订 */
export const LOCKED_CAMERA_STATUSES: MissionStatus[] = ['已飞行', '已归档'];

export function isCameraLockedStatus(status: MissionStatus): boolean {
  return LOCKED_CAMERA_STATUSES.includes(status);
}

/** 经纬度点 */
export type LngLat = [number, number];

/** 航拍任务 */
export interface Mission {
  id: string;
  /** 任务编号 */
  missionNo: string;
  name: string;
  /** 测区名称 */
  areaName: string;
  /** 测区边界经纬度数组 */
  areaPolygon: LngLat[];
  purpose: MissionPurpose;
  droneModel: string;
  cameraModel: string;
  /** 传感器宽度 mm */
  sensorWidth: number;
  /** 传感器高度 mm */
  sensorHeight: number;
  /** 焦距 mm */
  focalLength: number;
  /** 像元尺寸 μm */
  pixelSize: number;
  /** 绑定的相机预设族 id（对应 CameraPreset.familyId；无预设时为空） */
  presetId?: string;
  /**
   * 锁定的预设修订号：已飞/归档任务固定在飞行时的修订上；
   * 规划中/待飞任务也记录当前跟随到的修订，落后于最新修订时台账给出提示。
   */
  presetRevision?: number;
  flightDate: string;
  pilot: string;
  status: MissionStatus;
  createdAt: number;
}

export type MissionDraft = Omit<Mission, 'id' | 'createdAt'>;

/** 相机预设的一项修订（改参数只追加新行，绝不覆盖旧行） */
export interface CameraPreset {
  id: string;
  /** 同一相机预设族的稳定 id，跨修订不变；升级旧数据时取旧行 id */
  familyId: string;
  /** 修订号，从 1 起在族内递增 */
  revision: number;
  name: string;
  cameraModel: string;
  sensorWidth: number;
  sensorHeight: number;
  focalLength: number;
  pixelSize: number;
  /** 该修订生效时间（ms）；旧数据按飞行日期归档时取飞行日期 */
  createdAt: number;
  /** 旧数据升级补出来的基础修订 */
  basic?: boolean;
}

/** 新建预设（即新族的第 1 修订）的表单 */
export type CameraPresetDraft = Pick<
  CameraPreset,
  'name' | 'cameraModel' | 'sensorWidth' | 'sensorHeight' | 'focalLength' | 'pixelSize'
>;
