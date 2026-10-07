/** 航线参数 */
export interface FlightLine {
  id: string;
  missionId: string;
  /** 航线号 */
  lineNo: number;
  /** 航线间距 m */
  spacing: number;
  /** 拍照间隔 m */
  photoInterval: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 地面分辨率 cm/px */
  gsd: number;
  /** 预计张数 */
  estPhotos: number;
  /** 预计耗时 min */
  estDuration: number;
  /** 预计电池组数 */
  batteryCount: number;
  /** 航带方向 ° */
  heading: number;
  /** 保存航线参数时任务锁定的相机预设修订号（与飞行时修订一致，成果回算以此为准） */
  cameraRevision?: number;
  updatedAt: number;
}

export type FlightLineDraft = Omit<FlightLine, 'id' | 'updatedAt'>;
