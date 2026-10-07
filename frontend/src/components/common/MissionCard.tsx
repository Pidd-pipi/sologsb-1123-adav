import type { ReactNode } from 'react';
import { Button, Card, Descriptions, message, Space, Tag, Typography } from 'antd';
import type { Mission } from '../../types/mission';
import { polygonAreaM2 } from '../../utils/geoCalc';
import { hasAmapKey } from '../../utils/amapLoader';
import { missionCameraState } from '../../utils/camera';
import { useMissionStore } from '../../stores/missionStore';

export interface MissionCardProps {
  mission: Mission;
  waypointCount?: number;
  assetCount?: number;
  lineCount?: number;
  onOpen?: (id: string) => void;
  footer?: ReactNode;
}

const STATUS_COLOR: Record<string, string> = {
  规划中: 'default',
  待飞行: 'blue',
  已飞行: 'green',
  已归档: 'purple',
};

/** 相机修订标注：已飞/归档显示锁定修订，规划中/待飞显示跟随修订并标出是否落后 */
function RevisionTag({ mission }: { mission: Mission }) {
  const presets = useMissionStore((s) => s.presets);
  const catchupMission = useMissionStore((s) => s.catchupMission);
  const st = missionCameraState(mission, presets);

  if (!st.bound) {
    return <Tag>未绑定相机预设</Tag>;
  }
  if (st.locked) {
    return (
      <Tag color="purple" title="已飞行/归档，相机参数锁在飞行时的修订上">
        相机修订 r{st.currentRevision} · 飞行时锁定
      </Tag>
    );
  }
  return (
    <Space size={4}>
      <Tag color={st.outdated ? 'orange' : 'green'} data-testid={`revision-tag-${mission.missionNo}`}>
        相机修订 r{st.currentRevision}
        {st.outdated ? ` · 落后（最新 r${st.latest?.revision}）` : ' · 最新'}
      </Tag>
      {st.outdated ? (
        <Button
          size="small"
          type="link"
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await catchupMission(mission.id);
            } catch {
              /* 写入失败保留旧修订，提示后可再点此重试 */
              message.error(`同步修订失败，任务仍停留在 r${st.currentRevision}，可重试`);
            }
          }}
        >
          重试同步到 r{st.latest?.revision}
        </Button>
      ) : null}
    </Space>
  );
}

/** 任务摘要卡（编号、测区、机型、日期、航点数），被任务台账、航线规划页消费 */
export default function MissionCard({ mission, waypointCount, assetCount, lineCount, onOpen, footer }: MissionCardProps) {
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
          <RevisionTag mission={mission} />
        </Space>
      }
    >
      <Typography.Paragraph style={{ marginBottom: 6 }} strong>
        {mission.name}
      </Typography.Paragraph>
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
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        地图视图：{hasAmapKey() ? '高德 JS API' : '本地 SVG 网格（未配置 VITE_AMAP_KEY）'}
      </Typography.Text>
      {footer ? <div style={{ marginTop: 8 }}>{footer}</div> : null}
    </Card>
  );
}
