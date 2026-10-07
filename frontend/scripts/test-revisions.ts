import 'fake-indexeddb/auto';
import assert from 'node:assert';
import Dexie from 'dexie';
import { db, ensureSeedData, DB_VERSION } from '../src/utils/db';
import { useMissionStore } from '../src/stores/missionStore';
import { isMissionStale, revisionAtFlightDate, latestRevision, revisionsOf } from '../src/utils/presetRevisions';
import type { CameraPreset, Mission } from '../src/types/mission';

let passed = 0;
const ok = (name: string) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

async function testSeedAndPropagate() {
  console.log('1) 示范数据 + 追加修订传播 / 已飞锁定');
  await ensureSeedData();
  await useMissionStore.getState().load();

  const s0 = useMissionStore.getState();
  const flown = s0.items.find((m) => m.missionNo === 'DM-2024-018')!;
  const waiting = s0.items.find((m) => m.missionNo === 'DM-2024-021')!;
  assert.equal(flown.status, '已飞行');
  assert.equal(waiting.status, '待飞行');
  const seriesId = waiting.presetSeriesId;
  assert.ok(seriesId, '待飞任务应关联预设系列');
  assert.ok(flown.presetSeriesId, '已飞任务同样带系列与飞行时修订号');
  assert.equal(flown.presetRevision, 1);
  ok('示范任务带系列与修订字段');

  const beforeFocal = flown.focalLength;
  const beforePixel = flown.pixelSize;
  const beforeGsdAsset = (await db.table('assets').where('missionId').equals(flown.id).toArray())[0].gsd;

  // 追加 rev2：焦距 35 -> 28、像元 4.4 -> 4.0
  await useMissionStore.getState().revisePreset(seriesId, { focalLength: 28, pixelSize: 4.0 });

  const s2 = useMissionStore.getState();

  const revs = revisionsOf(s2.presets, seriesId);
  assert.equal(revs.length, 2, '旧 rev1 保留 + 新增 rev2');
  assert.equal(revs[0].id !== revs[1].id, true, '修订是不同的行（追加不覆盖）');
  assert.equal(revs[0].focalLength, 35);
  assert.equal(revs[1].focalLength, 28);
  ok('改参数只追加新修订，旧修订不被覆盖');

  const flown2 = s2.items.find((m) => m.id === flown.id)!;
  const waiting2 = s2.items.find((m) => m.id === waiting.id)!;
  assert.equal(waiting2.focalLength, 28, '待飞行任务跟随 rev2');
  assert.equal(waiting2.pixelSize, 4.0);
  assert.equal(waiting2.presetRevision, 2);
  assert.equal(flown2.focalLength, beforeFocal, '已飞任务仍锁 rev1');
  assert.equal(flown2.pixelSize, beforePixel);
  assert.equal(flown2.presetRevision, 1);
  ok('规划/待飞任务跟最新修订重算；已飞任务锁飞行时修订');

  assert.equal(isMissionStale(s2.presets, waiting2), false, '已传播的任务不落后');
  assert.equal(isMissionStale(s2.presets, flown2), false, '锁定任务不算落后');

  const assetsAfter = await db.table('assets').where('missionId').equals(flown.id).toArray();
  assert.ok(assetsAfter.every((a: any) => a.gsd === beforeGsdAsset), '成果影像 GSD 不变');
  ok('成果影像的分辨率（assets.gsd）与质量未被修订影响');
}

async function testRollbackAndRetry() {
  console.log('2) 写入失败整体回滚 + 旧修订保留可重试');
  const waiting = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
  const seriesId = waiting.presetSeriesId;
  const presetCountBefore = useMissionStore.getState().presets.filter((p) => p.seriesId === seriesId).length;

  // 让事务中“传播到任务”这步失败
  const origUpdate = db.missions.update.bind(db.missions);
  db.missions.update = (() => Promise.reject(new Error('simulated IO error'))) as typeof db.missions.update;
  await assert.rejects(
    () => useMissionStore.getState().revisePreset(seriesId, { focalLength: 24 }),
    /simulated IO error/,
  );
  db.missions.update = origUpdate;

  const rows = await db.table('presets').where('seriesId').equals(seriesId).toArray();
  assert.equal(rows.length, presetCountBefore, '失败后不残留半条新修订');
  const missionRow: any = await db.table('missions').get(waiting.id);
  assert.equal(missionRow.focalLength, 28, '失败后任务仍是旧修订参数');
  ok('事务回滚：旧修订与任务旧参数都还在');

  // 直接重试即可成功
  await useMissionStore.getState().revisePreset(seriesId, { focalLength: 24 });
  await useMissionStore.getState().load();
  const s1 = useMissionStore.getState();
  const w2 = s1.items.find((m) => m.id === waiting.id)!;
  assert.equal(w2.focalLength, 24);
  assert.equal(w2.presetRevision, 3, 'rev2(28) 失败未产生，成功这次是 rev3');
  ok('重试追加修订成功，任务跟随到新修订');

  // 制造一个落后任务：直接把库里任务改回 rev2 模拟“写任务那步漏掉”，再用 syncMission 重试
  await db.missions.update(waiting.id, { presetRevision: 2, focalLength: 28, pixelSize: 4.0 });
  await useMissionStore.getState().load();
  const s2 = useMissionStore.getState();
  const staleOne = s2.items.find((m) => m.id === waiting.id)!;
  assert.equal(isMissionStale(s2.presets, staleOne), true);
  await s2.syncMission(staleOne.id);
  const s3 = useMissionStore.getState();
  const fixed = s3.items.find((m) => m.id === waiting.id)!;
  assert.equal(fixed.presetRevision, 3);
  assert.equal(fixed.focalLength, 24);
  assert.equal(isMissionStale(s3.presets, fixed), false);
  ok('syncMission 把落后任务重试同步到最新修订');
}

async function testStatusLockTransition() {
  console.log('3) 状态切换：飞行时锁定、解锁后重新跟随');
  const s0 = useMissionStore.getState();
  const waiting = s0.items.find((m) => m.missionNo === 'DM-2024-021')!;
  const seriesId = waiting.presetSeriesId;
  // 当前系列最新 rev3（24mm）。任务正停在 rev3。先制造 rev4
  await s0.revisePreset(seriesId, { focalLength: 20 });

  // 建一个规划中任务停在 rev3
  const created = await s0.add({
    missionNo: 'DM-TEST-LOCK',
    name: '锁定测试',
    areaName: '测试区',
    areaPolygon: [
      [1, 1],
      [1.01, 1],
      [1.01, 1.01],
    ],
    purpose: '正射',
    droneModel: 'M300',
    cameraModel: 'Zenmuse P1',
    sensorWidth: 35.9,
    sensorHeight: 24,
    focalLength: 24,
    pixelSize: 4.0,
    presetSeriesId: seriesId,
    presetRevision: 3,
    flightDate: '2024-10-01',
    pilot: '测试',
    status: '规划中',
  });
  assert.equal(isMissionStale(useMissionStore.getState().presets, created), true);

  // 转为已飞行：先同步到最新（rev4, 20mm）再锁定
  await useMissionStore.getState().setStatus(created.id, '已飞行');
  let row: any = await db.missions.get(created.id);
  assert.equal(row.status, '已飞行');
  assert.equal(row.focalLength, 20);
  assert.equal(row.presetRevision, 4, '飞行时锁定到当时最新修订');
  ok('转已飞：先跟随到最新修订再锁定');

  // 再追加 rev5，锁定任务不动
  await useMissionStore.getState().revisePreset(seriesId, { focalLength: 18 });
  row = await db.missions.get(created.id);
  assert.equal(row.focalLength, 20);
  assert.equal(row.presetRevision, 4);
  ok('飞行后再追加修订，锁定任务不变');

  // 解锁回规划中：跟随最新 rev5
  await useMissionStore.getState().setStatus(created.id, '规划中');
  row = await db.missions.get(created.id);
  assert.equal(row.focalLength, 18);
  assert.equal(row.presetRevision, 5);
  ok('解锁回规划：重新跟随最新修订');
}

async function testMigration() {
  console.log('4) v2 -> v3 旧数据升级');
  await db.close();
  await new Promise((res) => indexedDB.deleteDatabase('gbdronemap').onsuccess = () => res(null));

  // 用旧结构（v2）建库灌老数据
  class OldDB extends Dexie {
    constructor() {
      super('gbdronemap');
      this.version(1).stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, createdAt',
        waypoints: 'id, missionId, seq, action',
        lines: 'id, missionId, lineNo',
        assets: 'id, missionId, imageNo, quality',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      });
      this.version(2).stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      });
    }
  }
  const old = new OldDB();
  const presets: any[] = [
    { id: 'p1', name: 'P4R', cameraModel: 'FC6310R', sensorWidth: 13.2, sensorHeight: 8.8, focalLength: 8.8, pixelSize: 2.4 },
    { id: 'p2', name: 'P1', cameraModel: 'Zenmuse P1', sensorWidth: 35.9, sensorHeight: 24, focalLength: 35, pixelSize: 4.4 },
  ];
  const missions: any[] = [
    // m1：参数与 p1 全等 → 归 p1 rev1
    {
      id: 'm1', missionNo: 'OLD-1', name: '老任务1', areaName: '区', areaPolygon: [], purpose: '正射',
      droneModel: 'P4', cameraModel: 'FC6310R', sensorWidth: 13.2, sensorHeight: 8.8, focalLength: 8.8, pixelSize: 2.4,
      flightDate: '2023-05-01', pilot: '', status: '已飞行', createdAt: 1,
    },
    // m2：相机型号匹配 p2 但参数被手工改过 → 型号兜底归 p2 rev1
    {
      id: 'm2', missionNo: 'OLD-2', name: '老任务2', areaName: '区', areaPolygon: [], purpose: '正射',
      droneModel: 'M300', cameraModel: 'Zenmuse P1', sensorWidth: 30, sensorHeight: 20, focalLength: 40, pixelSize: 3.9,
      flightDate: '2023-06-01', pilot: '', status: '已归档', createdAt: 2,
    },
    // m3：完全对不上 → 补一条基础预设
    {
      id: 'm3', missionNo: 'OLD-3', name: '老任务3', areaName: '区', areaPolygon: [], purpose: '正射',
      droneModel: '自制', cameraModel: '自制相机', sensorWidth: 9.9, sensorHeight: 7.7, focalLength: 6.6, pixelSize: 1.1,
      flightDate: '2023-07-01', pilot: '', status: '已飞行', createdAt: 3,
    },
    // m4：与 m3 参数全等 → 应共用补出来的基础预设系列
    {
      id: 'm4', missionNo: 'OLD-4', name: '老任务4', areaName: '区', areaPolygon: [], purpose: '正射',
      droneModel: '自制', cameraModel: '自制相机', sensorWidth: 9.9, sensorHeight: 7.7, focalLength: 6.6, pixelSize: 1.1,
      flightDate: '2023-08-01', pilot: '', status: '规划中', createdAt: 4,
    },
  ];
  await old.table('presets').bulkPut(presets);
  await old.table('missions').bulkPut(missions);
  await old.close();

  // 打开正式 DB（含 v3）触发迁移
  await db.open();
  assert.equal(db.verno, DB_VERSION);
  const migratedPresets: CameraPreset[] = await db.table('presets').toArray();
  const m1 = (await db.table('missions').get('m1')) as Mission;
  const m2 = (await db.table('missions').get('m2')) as Mission;
  const m3 = (await db.table('missions').get('m3')) as Mission;
  const m4 = (await db.table('missions').get('m4')) as Mission;

  assert.equal(m1.presetSeriesId, 'p1');
  assert.equal(m1.presetRevision, 1);
  assert.equal(m2.presetSeriesId, 'p2', '型号匹配兜底');
  assert.equal(m2.presetRevision, 1);
  assert.ok(m3.presetSeriesId, '无匹配时补基础预设');
  assert.equal(m3.presetRevision, 1);
  assert.equal(m3.focalLength, 6.6, '任务快照参数不被迁移改写');
  assert.equal(m4.presetSeriesId, m3.presetSeriesId, '相同参数共用同一条基础预设');
  const basic = migratedPresets.find((p) => p.seriesId === m3.presetSeriesId)!;
  assert.equal(basic.name.includes('基础预设'), true);
  assert.equal(basic.focalLength, 6.6);
  // 历史修订生效时间对飞行日期有效
  assert.ok(revisionAtFlightDate(migratedPresets, 'p1', '2023-05-01')?.revision === 1);
  // 任务自身的相机字段（GSD 来源）原样保留
  assert.equal(m1.sensorWidth, 13.2);
  assert.equal(m2.focalLength, 40);
  ok('旧预设补 rev1；旧任务按飞行日期归当时修订，无匹配补基础预设且同参数共用');
}

async function main() {
  try {
    await testSeedAndPropagate();
    await testRollbackAndRetry();
    await testStatusLockTransition();
    await testMigration();
    console.log(`\n全部 ${passed} 项断言场景通过`);
  } catch (e) {
    console.error('测试失败：', e);
    process.exit(1);
  }
}
main();
