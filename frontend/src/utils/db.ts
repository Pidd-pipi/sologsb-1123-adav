import Dexie, { type Table } from 'dexie';
import type { CameraPreset, Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { FlightLine } from '../types/flightline';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset } from '../types/imageasset';
import { newId } from './id';
import { revisionAtFlightDate } from './presetRevisions';

export const DB_NAME = 'gbdronemap';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbdronemap:db-version';

/** 旧数据升级时，历史修订的生效时间取很早以前，使其对任意飞行日期都生效 */
export const LEGACY_EFFECTIVE_AT = Date.UTC(1970, 0, 1);

class DroneMapDB extends Dexie {
  missions!: Table<Mission, string>;
  waypoints!: Table<Waypoint, string>;
  lines!: Table<FlightLine, string>;
  assets!: Table<ImageAsset, string>;
  thumbs!: Table<AssetThumb, string>;
  presets!: Table<CameraPreset, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, createdAt',
      waypoints: 'id, missionId, seq, action',
      lines: 'id, missionId, lineNo',
      assets: 'id, missionId, imageNo, quality',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
    });
    this.version(2)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      })
      .upgrade(async (tx) => {
        await tx
          .table('missions')
          .toCollection()
          .modify((row: any) => {
            if (!row.areaPolygon) row.areaPolygon = [];
            if (row.sensorWidth === undefined) row.sensorWidth = 13.2;
            if (row.sensorHeight === undefined) row.sensorHeight = 8.8;
            if (row.focalLength === undefined) row.focalLength = 8.8;
            if (row.pixelSize === undefined) row.pixelSize = 2.4;
          });
        await tx
          .table('lines')
          .toCollection()
          .modify((row: any) => {
            if (row.updatedAt === undefined) row.updatedAt = Date.now();
            if (row.batteryCount === undefined) row.batteryCount = 1;
          });
      });
    // v3：相机预设带修订号（同一系列修订只追加不覆盖），任务记录所跟/所锁的系列与修订
    this.version(3)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, presetSeriesId, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, seriesId, revision, name, cameraModel',
      })
      .upgrade(async (tx) => {
        const presetRows: any[] = await tx.table('presets').toArray();
        const missionRows: any[] = await tx.table('missions').toArray();

        // 1) 旧预设原地补为各自系列的 rev1，生效时间置为最早，绝不覆盖其参数
        presetRows.forEach((row) => {
          row.seriesId = row.seriesId ?? row.id;
          row.revision = row.revision ?? 1;
          row.effectiveAt = typeof row.effectiveAt === 'number' ? row.effectiveAt : LEGACY_EFFECTIVE_AT;
        });

        // 2) 旧任务按飞行日期归到当时修订；一条都对不上就用任务快照补一条基础预设
        const allPresets: CameraPreset[] = [...presetRows];
        const sameParams = (m: any, p: CameraPreset) =>
          Number(m.sensorWidth) === Number(p.sensorWidth) &&
          Number(m.sensorHeight) === Number(p.sensorHeight) &&
          Number(m.focalLength) === Number(p.focalLength) &&
          Number(m.pixelSize) === Number(p.pixelSize);
        const sameModel = (m: any, p: CameraPreset) =>
          !!(m.cameraModel && p.cameraModel && m.cameraModel === p.cameraModel);
        // 参数相同又匹配不到旧预设的多个任务，共用同一条补出来的基础预设
        const basicByKey = new Map<string, CameraPreset>();

        missionRows.forEach((m) => {
          if (m.presetSeriesId) return;
          const byParams = Array.from(new Set(allPresets.filter((p) => sameParams(m, p)).map((p) => p.seriesId)));
          const byModel =
            byParams.length > 0 ? [] : Array.from(new Set(allPresets.filter((p) => sameModel(m, p)).map((p) => p.seriesId)));
          let hit: CameraPreset | undefined;
          for (const sid of [...byParams, ...byModel]) {
            hit = revisionAtFlightDate(allPresets, sid, m.flightDate);
            if (hit) break;
          }
          if (hit) {
            m.presetSeriesId = hit.seriesId;
            m.presetRevision = hit.revision;
            return;
          }
          const key = [m.cameraModel ?? '', m.sensorWidth, m.sensorHeight, m.focalLength, m.pixelSize].join('|');
          let basic = basicByKey.get(key);
          if (!basic) {
            basic = {
              id: newId('preset'),
              seriesId: newId('series'),
              revision: 1,
              effectiveAt: LEGACY_EFFECTIVE_AT,
              name: `基础预设 · ${m.cameraModel || '手工录入'}`,
              cameraModel: m.cameraModel ?? '',
              sensorWidth: m.sensorWidth ?? 13.2,
              sensorHeight: m.sensorHeight ?? 8.8,
              focalLength: m.focalLength ?? 8.8,
              pixelSize: m.pixelSize ?? 2.4,
            };
            basicByKey.set(key, basic);
            allPresets.push(basic);
          }
          m.presetSeriesId = basic.seriesId;
          m.presetRevision = 1;
        });

        await tx.table('presets').bulkPut([...presetRows, ...Array.from(basicByKey.values())]);
        await tx.table('missions').bulkPut(missionRows);
      });
  }
}

export const db = new DroneMapDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 读取某任务的航线参数（每任务一条） */
export async function loadFlightLine(missionId: string): Promise<FlightLine | undefined> {
  const rows = await db.lines.where('missionId').equals(missionId).toArray();
  return rows.sort((a, b) => a.lineNo - b.lineNo)[0];
}

/** 保存 / 更新航线参数 */
export async function saveFlightLine(line: FlightLine): Promise<void> {
  await db.lines.put(line);
}

/** 按航线参数把任务拆分为多架次（每架次按电池组数分组） */
export function splitSorties(line: FlightLine): { sortie: number; photos: number; durationMin: number }[] {
  const perSortie = 20; // 每组电池有效续航 20 min
  const count = Math.max(1, Math.ceil(line.estDuration / perSortie));
  const photosPer = Math.ceil(line.estPhotos / count);
  const durationPer = Math.round((line.estDuration / count) * 10) / 10;
  return Array.from({ length: count }, (_, i) => ({
    sortie: i + 1,
    photos: photosPer,
    durationMin: durationPer,
  }));
}

/** 首次进入灌入示范任务、航点、航线参数与成果影像条目 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.missions.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const missionA = newId('mission');
  const missionB = newId('mission');
  // 相机预设以“系列 + 修订”的方式灌入
  const seriesMavic = newId('series');
  const seriesP1 = newId('series');
  const seriesP4 = newId('series');

  const polygonA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  const polygonB: [number, number][] = [
    [121.4726, 31.2321],
    [121.4789, 31.2334],
    [121.4796, 31.2288],
  ];

  const missions: Mission[] = [
    {
      id: missionA,
      missionNo: 'DM-2024-018',
      name: '中心城区正射影像采集',
      areaName: '北京东城测区',
      areaPolygon: polygonA,
      purpose: '正射',
      droneModel: 'Mavic 3E',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
      // 已飞行：锁在飞行时的 rev1 上，之后追加修订也不会带偏它与成果影像
      presetSeriesId: seriesMavic,
      presetRevision: 1,
      flightDate: '2024-09-12',
      pilot: '穆清和',
      status: '已飞行',
      createdAt: now - 30 * day,
    },
    {
      id: missionB,
      missionNo: 'DM-2024-021',
      name: '滨江带状倾斜摄影',
      areaName: '上海浦东滨江带',
      areaPolygon: polygonB,
      purpose: '带状',
      droneModel: 'M300 RTK',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
      // 待飞行：跟随系列最新修订
      presetSeriesId: seriesP1,
      presetRevision: 1,
      flightDate: '2024-09-20',
      pilot: '纪长风',
      status: '待飞行',
      createdAt: now - 8 * day,
    },
  ];

  const waypoints: Waypoint[] = [];
  // 示范任务 A：4 个航点形成一条覆盖测区的折线
  const wpsA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  wpsA.forEach(([lng, lat], index) => {
    waypoints.push({
      id: newId('wp'),
      missionId: missionA,
      seq: index + 1,
      lng,
      lat,
      altitude: 120,
      speed: 8,
      heading: 90,
      gimbalPitch: -90,
      action: index === wpsA.length - 1 ? '悬停' : '拍照',
      hoverSec: index === wpsA.length - 1 ? 5 : 0,
    });
  });
  waypoints.push({
    id: newId('wp'),
    missionId: missionB,
    seq: 1,
    lng: 121.4726,
    lat: 31.2321,
    altitude: 150,
    speed: 10,
    heading: 45,
    gimbalPitch: -60,
    action: '拍照',
    hoverSec: 0,
  });

  const lines: FlightLine[] = [
    {
      id: newId('line'),
      missionId: missionA,
      lineNo: 1,
      spacing: 62.5,
      photoInterval: 24.8,
      overlapForward: 75,
      overlapSide: 70,
      gsd: 3.22,
      estPhotos: 12,
      estDuration: 3.6,
      batteryCount: 1,
      heading: 90,
      updatedAt: now - 30 * day,
    },
    {
      id: newId('line'),
      missionId: missionB,
      lineNo: 1,
      spacing: 92.3,
      photoInterval: 42.1,
      overlapForward: 70,
      overlapSide: 65,
      gsd: 1.89,
      estPhotos: 9,
      estDuration: 4.2,
      batteryCount: 1,
      heading: 45,
      updatedAt: now - 8 * day,
    },
  ];

  const assets: ImageAsset[] = [];
  const thumbs: AssetThumb[] = [];
  const qualities: ImageAsset['quality'][] = ['合格', '合格', '模糊', '合格', '过曝', '合格'];
  qualities.forEach((quality, index) => {
    const id = newId('asset');
    const lng = 116.3916 + index * 0.0012;
    const lat = 39.9071 - (index % 2) * 0.0009;
    assets.push({
      id,
      missionId: missionA,
      imageNo: `IMG_${String(1001 + index)}`,
      lng,
      lat,
      altitude: 120,
      // 成果影像 GSD 是飞行实测值，永远不随预设修订变化
      gsd: 3.22,
      overlap: 76 - index,
      tiltAngle: 2 + index,
      shotAt: now - 30 * day + index * 12000,
      quality,
      folder: `/DM-2024-018/100MEDIA`,
    });
    thumbs.push({ id, missionId: missionA, dataUrl: makeThumbDataUrl(`IMG_${1001 + index}`, quality, lng, lat) });
  });

  const presets: CameraPreset[] = [
    {
      id: newId('preset'),
      seriesId: seriesMavic,
      revision: 1,
      effectiveAt: now - 60 * day,
      name: 'Mavic 3E 广角',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
    },
    {
      id: newId('preset'),
      seriesId: seriesP1,
      revision: 1,
      effectiveAt: now - 60 * day,
      name: 'Zenmuse P1 35mm',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
    },
    {
      id: newId('preset'),
      seriesId: seriesP4,
      revision: 1,
      effectiveAt: now - 60 * day,
      name: 'Phantom 4 RTK',
      cameraModel: 'FC6310R',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
    },
  ];

  // 六张表超过 Dexie 位置参数上限，改用数组形式声明事务范围
  await db.transaction('rw', [db.missions, db.waypoints, db.lines, db.assets, db.thumbs, db.presets], async () => {
    await db.missions.bulkPut(missions);
    await db.waypoints.bulkPut(waypoints);
    await db.lines.bulkPut(lines);
    await db.assets.bulkPut(assets);
    await db.thumbs.bulkPut(thumbs);
    await db.presets.bulkPut(presets);
  });
}
