import { useMemo } from 'react';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { missionCameraState } from '../utils/camera';
import {
  calcGsd,
  estimateBatteries,
  estimateDuration,
  estimatePhotos,
  lineSpacing,
  pathLengthMeters,
  photoInterval,
  polygonAreaM2,
} from '../utils/geoCalc';
import type { CameraPreset, LngLat, Mission } from '../types/mission';
import { isCameraLockedStatus } from '../types/mission';
import { revisionsOfFamily } from '../utils/camera';

export interface RouteParams {
  /** 相对航高 m */
  altitude: number;
  /** 航速 m/s */
  speed: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 航带方向 ° */
  heading: number;
}

export const DEFAULT_ROUTE_PARAMS: RouteParams = {
  altitude: 120,
  speed: 8,
  overlapForward: 75,
  overlapSide: 70,
  heading: 90,
};

export interface RouteMetrics {
  gsd: number;
  spacing: number;
  photoInterval: number;
  estPhotos: number;
  estDuration: number;
  batteryCount: number;
  /** 测区面积 m² */
  area: number;
  /** 航带路径长度 m */
  pathLength: number;
  /** 航点数量 */
  waypointCount: number;
  /** 预计航带数 */
  lineCount: number;
  coverageForward: number;
  coverageSide: number;
  sorties: { sortie: number; photos: number; durationMin: number }[];
}

/**
 * 由航高、焦距、像元尺寸算 GSD、航线间距、预计张数与耗时。
 * 被航线规划页（/missions/:id/route）与航点明细页（/missions/:id/waypoints）消费。
 */
export function useRouteMetrics(missionId: string | undefined, params: RouteParams = DEFAULT_ROUTE_PARAMS): RouteMetrics {
  const missions = useMissionStore((s) => s.items);
  const presets = useMissionStore((s) => s.presets);
  const allWaypoints = useWaypointStore((s) => s.items);

  return useMemo<RouteMetrics>(() => {
    const mission = missions.find((m) => m.id === missionId);
    const points: LngLat[] = allWaypoints
      .filter((w) => w.missionId === missionId)
      .sort((a, b) => a.seq - b.seq)
      .map((w) => [w.lng, w.lat] as LngLat);

    // 已飞/归档：用任务里冻结的快照（飞行时修订）；规划中/待飞：跟绑定族最新修订，
    // 即便任务行追赶写入暂时失败，回算仍以最新修订为准（旧修订仍在、可重试追赶）
    const camera = resolveMissionCamera(mission, presets);
    const sensorWidth = camera.sensorWidth;
    const sensorHeight = camera.sensorHeight;
    const focalLength = camera.focalLength;
    const pixelSize = camera.pixelSize;

    const gsd = calcGsd(pixelSize, params.altitude, focalLength);
    const spacing = lineSpacing(sensorWidth, params.altitude, focalLength, params.overlapSide);
    const interval = photoInterval(sensorHeight, params.altitude, focalLength, params.overlapForward);
    const area = mission ? polygonAreaM2(mission.areaPolygon) : 0;
    const pathLength = pathLengthMeters(points);
    // 按测区面积与航线间距估算航带数
    const side = area > 0 ? Math.sqrt(area) : 0;
    const lineCount = spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / spacing)) : 0;
    const effLineLength = lineCount > 0 ? (area > 0 ? area / (lineCount * Math.max(spacing, 1)) * spacing : 0) : 0;
    const estPhotos = estimatePhotos(effLineLength || side, interval, lineCount);
    const hoverSecTotal = allWaypoints
      .filter((w) => w.missionId === missionId)
      .reduce((s, w) => s + (w.action === '悬停' ? w.hoverSec : 0), 0);
    const estDuration = estimateDuration(pathLength, params.speed, points.length, hoverSecTotal);
    const batteryCount = estimateBatteries(estDuration);
    const perSortie = 20;
    const sortieCount = Math.max(1, Math.ceil(estDuration / perSortie));

    return {
      gsd,
      spacing,
      photoInterval: interval,
      estPhotos,
      estDuration,
      batteryCount,
      area,
      pathLength,
      waypointCount: points.length,
      lineCount,
      coverageForward: Math.round((sensorHeight * params.altitude) / (focalLength || 1) * 100) / 100,
      coverageSide: Math.round((sensorWidth * params.altitude) / (focalLength || 1) * 100) / 100,
      sorties: Array.from({ length: sortieCount }, (_, i) => ({
        sortie: i + 1,
        photos: Math.ceil(estPhotos / sortieCount),
        durationMin: Math.round((estDuration / sortieCount) * 10) / 10,
      })),
    };
  }, [missions, presets, allWaypoints, missionId, params]);
}

/**
 * 解析任务当前用于回算的相机参数：
 * 已飞/归档 → 任务快照（飞行时修订）；规划中/待飞 → 绑定族最新修订；未绑定 → 任务快照。
 */
export function resolveMissionCamera(
  mission: Mission | undefined,
  presets: CameraPreset[],
): Pick<Mission, 'cameraModel' | 'sensorWidth' | 'sensorHeight' | 'focalLength' | 'pixelSize'> {
  const fallback = {
    cameraModel: mission?.cameraModel ?? '',
    sensorWidth: mission?.sensorWidth ?? 13.2,
    sensorHeight: mission?.sensorHeight ?? 8.8,
    focalLength: mission?.focalLength ?? 8.8,
    pixelSize: mission?.pixelSize ?? 2.4,
  };
  if (!mission || !mission.presetId || isCameraLockedStatus(mission.status)) return fallback;
  const family = revisionsOfFamily(presets, mission.presetId);
  const latest = family[family.length - 1];
  return latest
    ? {
        cameraModel: latest.cameraModel,
        sensorWidth: latest.sensorWidth,
        sensorHeight: latest.sensorHeight,
        focalLength: latest.focalLength,
        pixelSize: latest.pixelSize,
      }
    : fallback;
}

/**
 * 页面消费任务相机参数的统一入口：
 * 返回当前生效相机（锁定修订或最新修订）与修订状态（锁定/落后）。
 */
export function useMissionCamera(mission: Mission | undefined) {
  const presets = useMissionStore((s) => s.presets);
  return useMemo(() => {
    const camera = resolveMissionCamera(mission, presets);
    const state = mission ? missionCameraState(mission, presets) : undefined;
    return { camera, state };
  }, [mission, presets]);
}
