/** 航拍用途 */
export type MissionPurpose = '正射' | '倾斜' | '带状';

export const MISSION_PURPOSES: MissionPurpose[] = ['正射', '倾斜', '带状'];

export type MissionStatus = '规划中' | '待飞行' | '已飞行' | '已归档';

export const MISSION_STATUSES: MissionStatus[] = ['规划中', '待飞行', '已飞行', '已归档'];

/** 已飞行 / 已归档：相机参数锁在飞行时的修订上 */
export const LOCKED_STATUSES: MissionStatus[] = ['已飞行', '已归档'];

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
  /** 关联的相机预设系列 id；空串表示手工录入、不跟修订 */
  presetSeriesId: string;
  /** 当前参数锁定/跟随的预设修订号；与系列 id 成对出现 */
  presetRevision: number;
  flightDate: string;
  pilot: string;
  status: MissionStatus;
  createdAt: number;
}

export type MissionDraft = Omit<Mission, 'id' | 'createdAt'>;

/** 相机预设修订（同一 seriesId 下 revision 单调递增，只追加、不覆盖） */
export interface CameraPreset {
  id: string;
  /** 同一款相机预设的系列 id，所有修订共用 */
  seriesId: string;
  /** 修订号，从 1 起；改参数追加新行而非覆盖旧行 */
  revision: number;
  /** 该修订的生效时间 ms；已飞任务按飞行日期取当时最新生效的修订 */
  effectiveAt: number;
  name: string;
  cameraModel: string;
  sensorWidth: number;
  sensorHeight: number;
  focalLength: number;
  pixelSize: number;
}

/** 新增预设系列时的入参（修订号由存储层补 1） */
export type CameraPresetDraft = Omit<CameraPreset, 'id' | 'seriesId' | 'revision' | 'effectiveAt'>;

/** 某系列修订时可改的字段 */
export type CameraPresetPatch = Partial<Pick<CameraPreset, 'name' | 'cameraModel' | 'sensorWidth' | 'sensorHeight' | 'focalLength' | 'pixelSize'>>;
