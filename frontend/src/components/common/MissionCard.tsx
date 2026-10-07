import type { ReactNode } from 'react';
import { Card, Descriptions, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { LockOutlined, WarningFilled } from '@ant-design/icons';
import { MISSION_STATUSES, type CameraPreset, type Mission, type MissionStatus } from '../../types/mission';
import { isMissionStale, isRevisionLocked, latestRevision, missionRevision } from '../../utils/presetRevisions';
import { polygonAreaM2 } from '../../utils/geoCalc';
import { hasAmapKey } from '../../utils/amapLoader';

export interface MissionCardProps {
  mission: Mission;
  presets?: CameraPreset[];
  waypointCount?: number;
  assetCount?: number;
  lineCount?: number;
  onOpen?: (id: string) => void;
  onStatusChange?: (id: string, status: MissionStatus) => void;
  onSync?: (id: string) => void;
  footer?: ReactNode;
}

const STATUS_COLOR: Record<string, string> = {
  规划中: 'default',
  待飞行: 'blue',
  已飞行: 'green',
  已归档: 'purple',
};

/** 相机修订标签：标出任务当前所用修订，以及是否落后于最新修订 */
function RevisionTag({ mission, presets, onSync }: { mission: Mission; presets: CameraPreset[]; onSync?: (id: string) => void }) {
  if (!mission.presetSeriesId) {
    return (
      <Tooltip title="相机参数为手工录入，不跟随任何预设修订">
        <Tag>手工相机参数</Tag>
      </Tooltip>
    );
  }
  const pinned = missionRevision(presets, mission);
  const latest = latestRevision(presets, mission.presetSeriesId);
  const locked = isRevisionLocked(mission);
  const stale = isMissionStale(presets, mission);
  const presetName = pinned?.name ?? latest?.name ?? '相机预设';

  return (
    <Tooltip
      title={
        locked
          ? `任务已${mission.status}，参数锁在飞行时的 ${presetName} rev${mission.presetRevision}，后续修订不影响成果`
          : `跟随 ${presetName}，当前 rev${mission.presetRevision}${latest ? `，最新 rev${latest.revision}` : ''}`
      }
    >
      <Space size={2}>
        <Tag color={locked ? 'green' : 'geekblue'} data-testid={`mission-rev-${mission.missionNo}`}>
          {locked ? <LockOutlined /> : null}
          {presetName} rev{mission.presetRevision}
        </Tag>
        {stale ? (
          <Tag
            color="warning"
            icon={<WarningFilled />}
            style={{ cursor: onSync ? 'pointer' : 'default' }}
            onClick={onSync ? () => onSync(mission.id) : undefined}
            data-testid={`mission-stale-${mission.missionNo}`}
          >
            落后于 rev{latest?.revision}，点击同步并重算
          </Tag>
        ) : null}
      </Space>
    </Tooltip>
  );
}

/** 任务摘要卡（编号、测区、机型、日期、航点数），被任务台账、航线规划页消费 */
export default function MissionCard({ mission, presets = [], waypointCount, assetCount, lineCount, onOpen, onStatusChange, onSync, footer }: MissionCardProps) {
  return (
    <Card
      size="small"
      hoverable={!!onOpen}
      onClick={onOpen ? () => onOpen(mission.id) : undefined}
      title={
        <Space size={6} wrap>
          <span data-testid={`mission-card-${mission.missionNo}`}>{mission.missionNo}</span>
          <Tag color={STATUS_COLOR[mission.status]}>{mission.status}</Tag>
          <Tag color="cyan">{mission.purpose}</Tag>
        </Space>
      }
    >
      <Typography.Paragraph style={{ marginBottom: 6 }} strong>
        {mission.name}
      </Typography.Paragraph>
      <div style={{ marginBottom: 8 }}>
        <RevisionTag mission={mission} presets={presets} onSync={onSync} />
      </div>
      <Descriptions size="small" column={2} colon={false}>
        <Descriptions.Item label="测区">{mission.areaName}</Descriptions.Item>
        <Descriptions.Item label="飞行日期">{mission.flightDate}</Descriptions.Item>
        <Descriptions.Item label="机型">{mission.droneModel}</Descriptions.Item>
        <Descriptions.Item label="相机">{mission.cameraModel}</Descriptions.Item>
        <Descriptions.Item label="航点">{waypointCount ?? 0} 个</Descriptions.Item>
        <Descriptions.Item label="航线">{lineCount ?? 0} 条</Descriptions.Item>
        <Descriptions.Item label="成果条目">{assetCount ?? 0} 张</Descriptions.Item>
        <Descriptions.Item label="测区面积">{polygonAreaM2(mission.areaPolygon).toFixed(0)} m²</Descriptions.Item>
        <Descriptions.Item label="飞手">{mission.pilot}</Descriptions.Item>
        <Descriptions.Item label="传感器">
          {mission.sensorWidth}×{mission.sensorHeight} mm / f{mission.focalLength} mm / {mission.pixelSize} μm
        </Descriptions.Item>
      </Descriptions>
      {onStatusChange ? (
        <div style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
            任务状态
          </Typography.Text>
          <Select
            size="small"
            style={{ width: 120 }}
            value={mission.status}
            onChange={(v) => onStatusChange(mission.id, v as MissionStatus)}
            options={MISSION_STATUSES.map((s) => ({ value: s, label: s }))}
          />
        </div>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        地图视图：{hasAmapKey() ? '高德 JS API' : '本地 SVG 网格（未配置 VITE_AMAP_KEY）'}
      </Typography.Text>
      {footer ? <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>{footer}</div> : null}
    </Card>
  );
}
