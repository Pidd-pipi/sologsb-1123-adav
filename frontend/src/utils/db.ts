import Dexie, { type Table } from 'dexie';
import type { CameraPreset, Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { FlightLine } from '../types/flightline';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset } from '../types/imageasset';
import { newId } from './id';

export const DB_NAME = 'gbdronemap';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbdronemap:db-version';

class DroneMapDB extends Dexie {
  missions!: Table<Mission, string>;
  waypoints!: Table<Waypoint, string>;
  lines!: Table<FlightLine, string>;
  assets!: Table<ImageAsset, string>;
  thumbs!: Table<AssetThumb, string>;
  /** 相机预设修订表：改参数只追加新行，旧修订永不覆盖 */
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
    // v3：相机预设改为「族 + 只追加修订」，任务记录绑定的预设族与锁定/跟随修订号
    this.version(3)
      .stores({
        missions:
          'id, missionNo, areaName, droneModel, flightDate, status, purpose, presetId, presetRevision, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, cameraRevision, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, familyId, revision, name, cameraModel, createdAt',
      })
      .upgrade(async (tx) => {
        // 1) 旧预设逐行升级为各自族的第 1 修订（旧 id 留作 familyId，旧数据不丢）
        const oldPresets = await tx.table('presets').toCollection().toArray();
        const rev1Presets: CameraPreset[] = oldPresets.map((p: any) => ({
          id: newId('preset'),
          familyId: p.id,
          revision: 1,
          name: p.name,
          cameraModel: p.cameraModel,
          sensorWidth: p.sensorWidth,
          sensorHeight: p.sensorHeight,
          focalLength: p.focalLength,
          pixelSize: p.pixelSize,
          createdAt: Date.now(),
        }));
        await tx.table('presets').clear();
        if (rev1Presets.length > 0) await tx.table('presets').bulkPut(rev1Presets);

        // 2) 旧任务按飞行日期归到当时修订；匹配不到预设族的，补一条基础修订
        const oldMissions = await tx.table('missions').toCollection().toArray();
        const basicByModel = new Map<string, CameraPreset>();
        const missionRevision = new Map<string, { presetId: string; revision: number }>();

        for (const m of oldMissions as any[]) {
          const flightAt = parseFlightDate(m.flightDate);
          const family = rev1Presets.find(
            (p) => p.cameraModel === m.cameraModel || p.name === m.cameraModel,
          );

          let presetId: string;
          let revision: number;
          if (family) {
            presetId = family.familyId;
            revision = pickRevisionAt([family], flightAt);
          } else {
            const key = String(m.cameraModel || '基础相机');
            let basic = basicByModel.get(key);
            if (!basic) {
              basic = {
                id: newId('preset'),
                familyId: newId('preset-family'),
                revision: 1,
                name: key === '基础相机' ? '基础相机预设' : `${key}（基础）`,
                cameraModel: key,
                sensorWidth: m.sensorWidth ?? 13.2,
                sensorHeight: m.sensorHeight ?? 8.8,
                focalLength: m.focalLength ?? 8.8,
                pixelSize: m.pixelSize ?? 2.4,
                // 生效时间取最早飞行日期，保证按飞行日期归档时能命中
                createdAt: flightAt ?? Date.now(),
                basic: true,
              };
              basicByModel.set(key, basic);
            }
            presetId = basic.familyId;
            revision = pickRevisionAt([basic], flightAt);
          }
          missionRevision.set(m.id, { presetId, revision });
        }

        if (basicByModel.size > 0) {
          await tx.table('presets').bulkPut([...basicByModel.values()]);
        }

        await tx
          .table('missions')
          .toCollection()
          .modify((row: any) => {
            const bound = missionRevision.get(row.id);
            if (bound) {
              row.presetId = bound.presetId;
              row.presetRevision = bound.revision;
            }
          });

        // 3) 航线参数与成果条目记录当时修订；成果 GSD/质量等字段一律不动
        await tx
          .table('lines')
          .toCollection()
          .modify((row: any) => {
            const bound = missionRevision.get(row.missionId);
            if (bound && row.cameraRevision === undefined) row.cameraRevision = bound.revision;
          });
        await tx
          .table('assets')
          .toCollection()
          .modify((row: any) => {
            const bound = missionRevision.get(row.missionId);
            if (bound && row.cameraRevision === undefined) row.cameraRevision = bound.revision;
          });
      });
  }
}

export const db = new DroneMapDB();

/** 飞行日期（YYYY-MM-DD）→ 当日 0 点时间戳；无法解析时返回 undefined */
export function parseFlightDate(flightDate: string | undefined): number | undefined {
  if (!flightDate) return undefined;
  const t = new Date(`${flightDate}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** 取某预设族在指定时刻已生效的最新修订；无时刻约束时返回 null */
export function pickRevisionAt(revisions: CameraPreset[], at: number | undefined): number {
  const sorted = [...revisions].sort((a, b) => a.revision - b.revision);
  if (at === undefined) return sorted[sorted.length - 1]?.revision ?? 1;
  const effective = sorted.filter((r) => r.createdAt <= at);
  return (effective[effective.length - 1] ?? sorted[0])?.revision ?? 1;
}

/** 族内最新修订 */
export function latestRevision(revisions: CameraPreset[]): CameraPreset | undefined {
  return [...revisions].sort((a, b) => b.revision - a.revision)[0];
}

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

/** 首次打开灌入示范任务、航点、航线参数与成果影像条目 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.missions.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const missionA = newId('mission');
  const missionB = newId('mission');

  // 三个相机预设族；族 2 有两次修订，用于演示「规划中任务跟随最新修订 / 台账标落后」
  const familyMavic = newId('preset-family');
  const familyP1 = newId('preset-family');
  const familyP4 = newId('preset-family');

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
      presetId: familyMavic,
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
      // 待飞行任务仍停在 r1，加载后由追赶逻辑跟到 r2（像元 4.4 → 4.2）
      presetId: familyP1,
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
      cameraRevision: 1,
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
      cameraRevision: 1,
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
      gsd: 3.22,
      overlap: 76 - index,
      tiltAngle: 2 + index,
      shotAt: now - 30 * day + index * 12000,
      quality,
      folder: `/DM-2024-018/100MEDIA`,
      cameraRevision: 1,
    });
    thumbs.push({ id, missionId: missionA, dataUrl: makeThumbDataUrl(`IMG_${1001 + index}`, quality, lng, lat) });
  });

  const presets: CameraPreset[] = [
    {
      id: newId('preset'),
      familyId: familyMavic,
      revision: 1,
      name: 'Mavic 3E 广角',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
      createdAt: now - 60 * day,
    },
    {
      id: newId('preset'),
      familyId: familyP1,
      revision: 1,
      name: 'Zenmuse P1 35mm',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
      createdAt: now - 40 * day,
    },
    {
      // r2：只追加，r1 保留；待飞行任务打开后自动跟到这里
      id: newId('preset'),
      familyId: familyP1,
      revision: 2,
      name: 'Zenmuse P1 35mm',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.2,
      createdAt: now - 2 * day,
    },
    {
      id: newId('preset'),
      familyId: familyP4,
      revision: 1,
      name: 'Phantom 4 RTK',
      cameraModel: 'FC6310R',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
      createdAt: now - 60 * day,
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
