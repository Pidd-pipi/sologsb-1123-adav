import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  type TableProps,
} from 'antd';
import { HistoryOutlined, PlusOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import { isMissionStale, isRevisionLocked, latestRevision, revisionsOf } from '../utils/presetRevisions';
import type { CameraPreset as CameraPresetModel, CameraPresetPatch } from '../types/mission';

interface SeriesRow {
  seriesId: string;
  name: string;
  cameraModel: string;
  latest: CameraPresetModel;
  revisionCount: number;
  followerCount: number;
  lockedCount: number;
}

const EMPTY_PATCH: CameraPresetPatch = {
  name: '',
  cameraModel: '',
  sensorWidth: 13.2,
  sensorHeight: 8.8,
  focalLength: 8.8,
  pixelSize: 2.4,
};

/** /settings/camera 相机与传感器参数预设管理：参数修订只追加不覆盖，规划中任务跟随、已飞任务锁定 */
export default function CameraPreset() {
  const missions = useMissionStore((s) => s.items);
  const presets = useMissionStore((s) => s.presets);
  const addPreset = useMissionStore((s) => s.addPreset);
  const revisePreset = useMissionStore((s) => s.revisePreset);
  const removePreset = useMissionStore((s) => s.removePreset);
  const applyPreset = useMissionStore((s) => s.applyPreset);

  const [missionId, setMissionId] = useState('');
  const [seriesId, setSeriesId] = useState('');
  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [draft, setDraft] = useState({
    name: '',
    cameraModel: '',
    sensorWidth: 13.2,
    sensorHeight: 8.8,
    focalLength: 8.8,
    pixelSize: 2.4,
  });
  // 修订弹窗
  const [reviseTarget, setReviseTarget] = useState<SeriesRow | null>(null);
  const [revisePatch, setRevisePatch] = useState<CameraPresetPatch>({ ...EMPTY_PATCH });
  const [historyOf, setHistoryOf] = useState<SeriesRow | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const seriesRows = useMemo<SeriesRow[]>(() => {
    const map = new Map<string, SeriesRow>();
    presets.forEach((p) => {
      const list = revisionsOf(presets, p.seriesId);
      const latest = list[list.length - 1];
      const followers = missions.filter((m) => m.presetSeriesId === p.seriesId);
      map.set(p.seriesId, {
        seriesId: p.seriesId,
        name: latest.name,
        cameraModel: latest.cameraModel,
        latest,
        revisionCount: list.length,
        followerCount: followers.filter((m) => !isRevisionLocked(m)).length,
        lockedCount: followers.filter((m) => isRevisionLocked(m)).length,
      });
    });
    return Array.from(map.values());
  }, [presets, missions]);

  useEffect(() => {
    if (!missionId) {
      const firstUnlocked = missions.find((m) => !isRevisionLocked(m));
      if (firstUnlocked) setMissionId(firstUnlocked.id);
    }
    if (!seriesId && seriesRows.length > 0) setSeriesId(seriesRows[0].seriesId);
  }, [missions, seriesRows, missionId, seriesId]);

  const metrics = useRouteMetrics(missionId, params);
  const selectedMission = missions.find((m) => m.id === missionId);
  const missionLocked = selectedMission ? isRevisionLocked(selectedMission) : false;
  const missionStale = selectedMission ? isMissionStale(presets, selectedMission) : false;

  const openRevise = (row: SeriesRow) => {
    setReviseTarget(row);
    setRevisePatch({
      name: row.latest.name,
      cameraModel: row.latest.cameraModel,
      sensorWidth: row.latest.sensorWidth,
      sensorHeight: row.latest.sensorHeight,
      focalLength: row.latest.focalLength,
      pixelSize: row.latest.pixelSize,
    });
  };

  const submitRevise = async () => {
    if (!reviseTarget) return;
    if (!String(revisePatch.name ?? '').trim() || !String(revisePatch.cameraModel ?? '').trim()) {
      setError('预设名与相机型号必填');
      return;
    }
    const base = reviseTarget.latest;
    const numericKeys = ['sensorWidth', 'sensorHeight', 'focalLength', 'pixelSize'] as const;
    const changed =
      String(revisePatch.name ?? '').trim() !== base.name ||
      String(revisePatch.cameraModel ?? '').trim() !== base.cameraModel ||
      numericKeys.some((k) => Number(revisePatch[k]) !== Number(base[k]));
    if (!changed) {
      setError('参数没有变化：改参数才会追加新修订');
      return;
    }
    try {
      // 只追加不覆盖；同事务传播到规划中/待飞行任务，失败整体回滚、旧修订保留可重试
      const rev = await revisePreset(reviseTarget.seriesId, {
        name: String(revisePatch.name ?? '').trim(),
        cameraModel: String(revisePatch.cameraModel ?? '').trim(),
        sensorWidth: Number(revisePatch.sensorWidth),
        sensorHeight: Number(revisePatch.sensorHeight),
        focalLength: Number(revisePatch.focalLength),
        pixelSize: Number(revisePatch.pixelSize),
      });
      const followers = seriesRows.find((r) => r.seriesId === reviseTarget.seriesId)?.followerCount ?? 0;
      setError('');
      setToast(
        `已追加「${rev.name}」rev${rev.revision}（旧修订保留）` +
          (followers > 0 ? `，${followers} 个规划中/待飞行任务已跟随并重算；已飞/归档任务保持锁定` : ''),
      );
      setReviseTarget(null);
    } catch (e) {
      setError(`修订写入失败，旧修订未改动，可直接重试：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const columns: NonNullable<TableProps<SeriesRow>['columns']> = [
    { title: '预设系列', dataIndex: 'name', width: 180, render: (_: unknown, row: SeriesRow) => (
      <Space direction="vertical" size={0}>
        <Typography.Text strong>{row.name}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          最新 rev{row.latest.revision} · 共 {row.revisionCount} 个修订
        </Typography.Text>
      </Space>
    ) },
    { title: '相机型号', dataIndex: 'cameraModel', width: 190 },
    {
      title: '传感器 mm',
      width: 140,
      render: (_: unknown, row: SeriesRow) => `${row.latest.sensorWidth} × ${row.latest.sensorHeight}`,
    },
    { title: '焦距 mm', width: 90, render: (_: unknown, row: SeriesRow) => row.latest.focalLength },
    { title: '像元 μm', width: 90, render: (_: unknown, row: SeriesRow) => row.latest.pixelSize },
    {
      title: '120 m 航高 GSD',
      width: 140,
      render: (_: unknown, row: SeriesRow) =>
        `${Math.round(((row.latest.pixelSize * 120) / (row.latest.focalLength * 10)) * 100) / 100} cm/px`,
    },
    {
      title: '引用任务',
      width: 190,
      render: (_: unknown, row: SeriesRow) => (
        <Space size={4} wrap>
          <Tag color="blue">跟随中 {row.followerCount}</Tag>
          <Tag color="green">已锁定 {row.lockedCount}</Tag>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_: unknown, row: SeriesRow) => (
        <Space size={4}>
          <Button size="small" type="primary" ghost onClick={() => openRevise(row)}>
            改参数 · 追加修订
          </Button>
          <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOf(row)}>
            修订史
          </Button>
          <Button
            size="small"
            danger
            onClick={async () => {
              try {
                await removePreset(row.seriesId);
                setToast(`已删除预设系列「${row.name}」及其全部修订`);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          相机与传感器参数预设
        </Typography.Title>
        <Tag>预设系列 {seriesRows.length} 套</Tag>
        <Tag color="blue">修订 {presets.length} 条（只追加）</Tag>
        <Tag color="green">已飞/归档任务锁定飞行时修订</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to="/missions">返回任务台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Alert
        type="info"
        showIcon
        message="修订规则：修改相机参数会追加一条新修订，旧修订永久保留；规划中/待飞行任务自动跟随最新修订并重算 GSD、航线间距、预计张数与架次；已飞行/已归档任务锁在飞行时修订，成果影像的分辨率与质量不变。写入失败时旧修订原样保留，可直接重试。"
      />

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="预设系列清单（按最新修订展示）">
            <Table<SeriesRow>
              rowKey="seriesId"
              size="small"
              columns={columns}
              dataSource={seriesRows}
              pagination={false}
              locale={{ emptyText: '暂无相机预设' }}
            />
          </Card>

          <Card size="small" title="新增预设系列（首版 rev1）" style={{ marginTop: 14 }}>
            <Space wrap size={10}>
              <Input
                style={{ width: 170 }}
                placeholder="预设名"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Input
                style={{ width: 200 }}
                placeholder="相机型号"
                value={draft.cameraModel}
                onChange={(e) => setDraft({ ...draft, cameraModel: e.target.value })}
              />
              <span>
                传感器宽{' '}
                <InputNumber value={draft.sensorWidth} step={0.1} onChange={(v) => setDraft({ ...draft, sensorWidth: Number(v) })} />
              </span>
              <span>
                高 <InputNumber value={draft.sensorHeight} step={0.1} onChange={(v) => setDraft({ ...draft, sensorHeight: Number(v) })} />
              </span>
              <span>
                焦距 <InputNumber value={draft.focalLength} step={0.01} onChange={(v) => setDraft({ ...draft, focalLength: Number(v) })} />
              </span>
              <span>
                像元 <InputNumber value={draft.pixelSize} step={0.1} onChange={(v) => setDraft({ ...draft, pixelSize: Number(v) })} />
              </span>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={async () => {
                  if (!draft.name.trim() || !draft.cameraModel.trim()) {
                    setError('预设名与相机型号必填');
                    return;
                  }
                  await addPreset({ ...draft, name: draft.name.trim(), cameraModel: draft.cameraModel.trim() });
                  setError('');
                  setToast(`已新增预设系列「${draft.name.trim()}」rev1`);
                  setDraft({ ...draft, name: '', cameraModel: '' });
                }}
              >
                保存预设
              </Button>
            </Space>
          </Card>

          <Card size="small" title="带入到任务（仅规划中/待飞行可跟随）" style={{ marginTop: 14 }}>
            <Space wrap size={10}>
              <Select
                style={{ width: 300 }}
                placeholder="选择任务"
                value={missionId || undefined}
                onChange={setMissionId}
                options={missions.map((m) => ({
                  value: m.id,
                  label: `${m.missionNo} · ${m.areaName}（${m.status}）`,
                  disabled: isRevisionLocked(m),
                }))}
              />
              <Select
                style={{ width: 240 }}
                placeholder="选择预设系列"
                value={seriesId || undefined}
                onChange={setSeriesId}
                options={seriesRows.map((r) => ({ value: r.seriesId, label: `${r.name}（最新 rev${r.latest.revision}）` }))}
              />
              <Button
                type="primary"
                disabled={!missionId || !seriesId || missionLocked}
                onClick={async () => {
                  try {
                    await applyPreset(missionId, seriesId);
                    const row = seriesRows.find((r) => r.seriesId === seriesId);
                    setToast(`已把「${row?.name ?? ''}」rev${row?.latest.revision} 带入任务，航线指标按新参数重算`);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                带入任务
              </Button>
            </Space>
            {selectedMission ? (
              <Space direction="vertical" size={2} style={{ marginTop: 10 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  当前任务传感器：{selectedMission.sensorWidth} × {selectedMission.sensorHeight} mm / f
                  {selectedMission.focalLength} mm / {selectedMission.pixelSize} μm
                </Typography.Paragraph>
                <Space size={4}>
                  {selectedMission.presetSeriesId ? (
                    <Tag color={missionLocked ? 'green' : 'geekblue'}>
                      {missionLocked ? '已锁定' : '跟随'} rev{selectedMission.presetRevision}
                    </Tag>
                  ) : (
                    <Tag>手工相机参数</Tag>
                  )}
                  {missionLocked ? <Tag color="green">已飞/归档，不接受预设变更</Tag> : null}
                  {missionStale ? <Tag color="warning">落后于最新修订，请回台账点“同步”重试</Tag> : null}
                </Space>
              </Space>
            ) : null}
          </Card>
        </Col>

        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
          />
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message={
              missionLocked
                ? '该任务已飞/归档：面板展示的是飞行时修订参数下的历史指标，改航高仅为试算，不会写回任务。'
                : '该任务规划中：相机参数跟随最新修订，航高/重叠率改动实时回算，保存航线参数即按当前修订落账。'
            }
          />
        </Col>
      </Row>

      {/* 改参数 → 追加修订 */}
      <Modal
        open={!!reviseTarget}
        title={reviseTarget ? `改参数 · 追加修订：${reviseTarget.name}（当前 rev${reviseTarget.latest.revision}）` : ''}
        width={620}
        onCancel={() => setReviseTarget(null)}
        onOk={submitRevise}
        okText={`追加为 rev${(reviseTarget?.latest.revision ?? 0) + 1}`}
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`旧修订 rev${reviseTarget?.latest.revision} 保留不动；保存后 ${reviseTarget?.followerCount ?? 0} 个规划中/待飞行任务跟随重算，${reviseTarget?.lockedCount ?? 0} 个已飞/归档任务继续锁定旧修订。`}
        />
        <Space wrap size={10}>
          <Input
            style={{ width: 200 }}
            addonBefore="预设名"
            value={String(revisePatch.name ?? '')}
            onChange={(e) => setRevisePatch({ ...revisePatch, name: e.target.value })}
          />
          <Input
            style={{ width: 240 }}
            addonBefore="相机型号"
            value={String(revisePatch.cameraModel ?? '')}
            onChange={(e) => setRevisePatch({ ...revisePatch, cameraModel: e.target.value })}
          />
          <span>
            传感器宽{' '}
            <InputNumber value={Number(revisePatch.sensorWidth)} step={0.1} onChange={(v) => setRevisePatch({ ...revisePatch, sensorWidth: Number(v) })} />
          </span>
          <span>
            高 <InputNumber value={Number(revisePatch.sensorHeight)} step={0.1} onChange={(v) => setRevisePatch({ ...revisePatch, sensorHeight: Number(v) })} />
          </span>
          <span>
            焦距 <InputNumber value={Number(revisePatch.focalLength)} step={0.01} onChange={(v) => setRevisePatch({ ...revisePatch, focalLength: Number(v) })} />
          </span>
          <span>
            像元 <InputNumber value={Number(revisePatch.pixelSize)} step={0.1} onChange={(v) => setRevisePatch({ ...revisePatch, pixelSize: Number(v) })} />
          </span>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>
          120 m 航高预览 GSD：
          {Math.round(((Number(revisePatch.pixelSize) * 120) / (Number(revisePatch.focalLength) * 10)) * 100) / 100} cm/px
        </Typography.Paragraph>
      </Modal>

      {/* 修订史 */}
      <Modal open={!!historyOf} title={historyOf ? `修订史 · ${historyOf.name}` : ''} width={640} footer={null} onCancel={() => setHistoryOf(null)}>
        {historyOf ? (
          <Timeline
            items={revisionsOf(presets, historyOf.seriesId)
              .slice()
              .reverse()
              .map((p) => ({
                color: p.revision === historyOf.latest.revision ? 'blue' : 'gray',
                children: (
                  <Space direction="vertical" size={2}>
                    <Space size={6}>
                      <Typography.Text strong>rev{p.revision}</Typography.Text>
                      {p.revision === historyOf.latest.revision ? <Tag color="blue">最新</Tag> : null}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        生效 {new Date(p.effectiveAt).toLocaleString('zh-CN')}
                      </Typography.Text>
                    </Space>
                    <Typography.Text>
                      {p.cameraModel} · {p.sensorWidth}×{p.sensorHeight} mm / f{p.focalLength} mm / {p.pixelSize} μm
                    </Typography.Text>
                  </Space>
                ),
              }))}
          />
        ) : null}
      </Modal>
    </Space>
  );
}
