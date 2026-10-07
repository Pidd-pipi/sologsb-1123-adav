import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
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
  message,
  type TableProps,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import { groupPresets, type PresetFamily } from '../utils/camera';
import { isCameraLockedStatus, type CameraPresetDraft, type Mission } from '../types/mission';

type FamilyRow = PresetFamily & { key: string; usedBy: Mission[] };

/** /settings/camera 相机与传感器参数预设管理：改参数只追加修订，规划中任务跟最新，已飞任务锁定 */
export default function CameraPreset() {
  const missions = useMissionStore((s) => s.items);
  const presets = useMissionStore((s) => s.presets);
  const addPreset = useMissionStore((s) => s.addPreset);
  const revisePreset = useMissionStore((s) => s.revisePreset);
  const applyPreset = useMissionStore((s) => s.applyPreset);
  const removePresetFamily = useMissionStore((s) => s.removePresetFamily);

  const [missionId, setMissionId] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [addForm] = Form.useForm<CameraPresetDraft>();
  const [reviseForm] = Form.useForm<CameraPresetDraft>();
  const [revisingFamily, setRevisingFamily] = useState<PresetFamily | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const families = useMemo(
    () =>
      groupPresets(presets).map((f) => ({
        ...f,
        key: f.familyId,
        usedBy: missions.filter((m) => m.presetId === f.familyId),
      })),
    [presets, missions],
  );

  useEffect(() => {
    if (!missionId && missions.length > 0) setMissionId(missions[0].id);
    if (!familyId && families.length > 0) setFamilyId(families[0].familyId);
  }, [missions, families, missionId, familyId]);

  const metrics = useRouteMetrics(missionId, params);
  const selectedMission = missions.find((m) => m.id === missionId);
  const selectedFamily = families.find((f) => f.familyId === familyId);
  const selectedLocked = selectedMission ? isCameraLockedStatus(selectedMission.status) : false;

  const gsdAt = (p: { pixelSize: number; focalLength: number }) =>
    `${Math.round(((p.pixelSize * 120) / (p.focalLength * 10)) * 100) / 100} cm/px`;

  const openRevise = (family: PresetFamily) => {
    setRevisingFamily(family);
    reviseForm.setFieldsValue({
      name: family.latest.name,
      cameraModel: family.latest.cameraModel,
      sensorWidth: family.latest.sensorWidth,
      sensorHeight: family.latest.sensorHeight,
      focalLength: family.latest.focalLength,
      pixelSize: family.latest.pixelSize,
    });
  };

  const submitRevise = async () => {
    const family = revisingFamily;
    if (!family) return;
    const values = await reviseForm.validateFields();
    try {
      const result = await revisePreset(family.familyId, values);
      if (result.failedMissionIds.length > 0) {
        message.warning(`新修订 r${result.revision.revision} 已保存，但有 ${result.failedMissionIds.length} 个任务同步失败，可在台账重试`);
      } else {
        message.success(`已发布修订 r${result.revision.revision}，规划中任务已自动跟随（旧修订保留）`);
      }
      setRevisingFamily(null);
    } catch {
      message.error('修订写入失败，旧修订完整保留，可重试');
    }
  };

  const columns: NonNullable<TableProps<FamilyRow>['columns']> = [
    {
      title: '预设（最新修订）',
      render: (_: unknown, row: FamilyRow) => (
        <Space direction="vertical" size={2}>
          <Space size={6}>
            <strong>{row.latest.name}</strong>
            <Tag color="blue">r{row.latest.revision}</Tag>
            {row.revisions.length > 1 ? <Tag>{row.revisions.length} 个修订</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.latest.cameraModel} · {row.latest.sensorWidth}×{row.latest.sensorHeight} mm · f{row.latest.focalLength} mm ·{' '}
            {row.latest.pixelSize} μm · 120 m GSD {gsdAt(row.latest)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '引用任务',
      width: 260,
      render: (_: unknown, row: FamilyRow) =>
        row.usedBy.length === 0 ? (
          <Typography.Text type="secondary">暂无任务引用</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.usedBy.map((m) => {
              const locked = isCameraLockedStatus(m.status);
              return (
                <Tag key={m.id} color={locked ? 'purple' : 'default'}>
                  {m.missionNo}
                  {m.presetRevision ? ` · r${m.presetRevision}` : ''}
                  {locked ? ' · 锁定' : ''}
                </Tag>
              );
            })}
          </Space>
        ),
    },
    {
      title: '操作',
      width: 280,
      render: (_: unknown, row: FamilyRow) => (
        <Space size={4}>
          <Button size="small" type="primary" ghost onClick={() => openRevise(row)}>
            发布新修订
          </Button>
          <Button size="small" onClick={() => setExpandedKeys((keys) => (keys.includes(row.key) ? keys.filter((k) => k !== row.key) : [...keys, row.key]))}>
            修订历史
          </Button>
          <Button
            size="small"
            danger
            onClick={async () => {
              try {
                await removePresetFamily(row.familyId);
                message.success('已删除该预设族的全部修订');
              } catch (e) {
                message.error(e instanceof Error ? e.message : '删除失败');
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
        <Tag>预设族 {families.length} 套</Tag>
        <Tag color="blue">修订 {presets.length} 条</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to="/missions">返回任务台账</Link>
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        message="改参数只追加新修订，不覆盖旧修订：规划中/待飞行任务自动跟最新修订，已飞行/已归档任务锁在飞行时修订，成果影像的分辨率与质量不变。"
      />
      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="预设清单（展开查看修订历史）">
            <Table<FamilyRow>
              rowKey="key"
              size="small"
              columns={columns}
              dataSource={families}
              pagination={false}
              expandable={{
                expandedRowKeys: expandedKeys,
                onExpand: (_expanded, row) =>
                  setExpandedKeys((keys) => (keys.includes(row.key) ? keys.filter((k) => k !== row.key) : [...keys, row.key])),
                expandedRowRender: (row) => (
                  <Timeline
                    items={[...row.revisions]
                      .reverse()
                      .map((p) => ({
                        color: p.revision === row.latest.revision ? 'blue' : p.basic ? 'gray' : 'green',
                        children: (
                          <Space direction="vertical" size={0}>
                            <Space size={6}>
                              <strong>r{p.revision}</strong>
                              {p.basic ? <Tag>旧数据补的基础修订</Tag> : null}
                              {p.revision === row.latest.revision ? <Tag color="blue">最新</Tag> : null}
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {new Date(p.createdAt).toLocaleString('zh-CN')}
                              </Typography.Text>
                            </Space>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {p.name} · {p.cameraModel} · {p.sensorWidth}×{p.sensorHeight} mm · f{p.focalLength} mm · {p.pixelSize} μm ·
                              120 m GSD {gsdAt(p)}
                            </Typography.Text>
                          </Space>
                        ),
                      }))}
                  />
                ),
              }}
              locale={{ emptyText: '暂无相机预设' }}
            />
          </Card>

          <Card size="small" title="新增预设族（保存为 r1，后续改动通过发布修订追加）" style={{ marginTop: 14 }}>
            <Form
              form={addForm}
              layout="inline"
              initialValues={{
                name: '',
                cameraModel: '',
                sensorWidth: 13.2,
                sensorHeight: 8.8,
                focalLength: 8.8,
                pixelSize: 2.4,
              }}
              onFinish={async (values) => {
                await addPreset(values);
                message.success(`已新增预设族「${values.name}」（r1）`);
                addForm.resetFields();
              }}
            >
              <Form.Item name="name" rules={[{ required: true, message: '预设名必填' }]}>
                <Input style={{ width: 170 }} placeholder="预设名" />
              </Form.Item>
              <Form.Item name="cameraModel" rules={[{ required: true, message: '相机型号必填' }]}>
                <Input style={{ width: 200 }} placeholder="相机型号" />
              </Form.Item>
              <Form.Item name="sensorWidth" label="传感器宽">
                <InputNumber step={0.1} />
              </Form.Item>
              <Form.Item name="sensorHeight" label="高">
                <InputNumber step={0.1} />
              </Form.Item>
              <Form.Item name="focalLength" label="焦距">
                <InputNumber step={0.01} />
              </Form.Item>
              <Form.Item name="pixelSize" label="像元">
                <InputNumber step={0.1} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
                  保存 r1
                </Button>
              </Form.Item>
            </Form>
          </Card>

          <Card size="small" title="带入到任务" style={{ marginTop: 14 }}>
            <Space wrap size={10}>
              <Select
                style={{ width: 300 }}
                placeholder="选择任务"
                value={missionId || undefined}
                onChange={setMissionId}
                options={missions.map((m) => ({
                  value: m.id,
                  label: `${m.missionNo} · ${m.areaName}（${m.status}）`,
                }))}
              />
              <Select
                style={{ width: 220 }}
                placeholder="选择预设族"
                value={familyId || undefined}
                onChange={setFamilyId}
                options={families.map((f) => ({ value: f.familyId, label: `${f.latest.name}（r${f.latest.revision}）` }))}
              />
              <Button
                type="primary"
                disabled={!missionId || !familyId || selectedLocked}
                onClick={async () => {
                  try {
                    await applyPreset(missionId, familyId);
                    setToast(`已把「${selectedFamily?.latest.name ?? ''} r${selectedFamily?.latest.revision}」带入 ${selectedMission?.missionNo ?? ''}`);
                  } catch (e) {
                    message.error(e instanceof Error ? e.message : '带入失败');
                  }
                }}
              >
                带入任务
              </Button>
            </Space>
            {selectedMission ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>
                当前任务传感器：{selectedMission.sensorWidth} × {selectedMission.sensorHeight} mm / f{selectedMission.focalLength} mm /{' '}
                {selectedMission.pixelSize} μm
                {selectedLocked ? (
                  <Tag color="purple" style={{ marginLeft: 8 }}>
                    {selectedMission.status}：修订 r{selectedMission.presetRevision ?? '-'} 已锁定，不能带入
                  </Tag>
                ) : (
                  <Tag color="green" style={{ marginLeft: 8 }}>
                    {selectedMission.status}：带入后跟最新修订
                  </Tag>
                )}
              </Typography.Paragraph>
            ) : null}
          </Card>
        </Col>

        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
          />
        </Col>
      </Row>

      <Modal
        open={!!revisingFamily}
        title={`发布新修订 · ${revisingFamily?.latest.name ?? ''}（当前 r${revisingFamily?.latest.revision} → r${(revisingFamily?.latest.revision ?? 0) + 1}）`}
        onCancel={() => setRevisingFamily(null)}
        onOk={submitRevise}
        okText="追加新修订（不覆盖旧的）"
        cancelText="取消"
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message="保存后旧修订原样保留；规划中/待飞行任务自动跟随新参数重算，已飞行/已归档任务及其成果影像不变。"
        />
        <Form form={reviseForm} layout="vertical">
          <Row gutter={10}>
            <Col span={12}>
              <Form.Item name="name" label="预设名" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cameraModel" label="相机型号" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={10}>
            <Col span={12}>
              <Form.Item name="sensorWidth" label="传感器宽 mm">
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sensorHeight" label="传感器高 mm">
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="focalLength" label="焦距 mm">
                <InputNumber style={{ width: '100%' }} step={0.01} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="pixelSize" label="像元 μm">
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Space>
  );
}
