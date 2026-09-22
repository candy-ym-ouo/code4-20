-- 低余量与临期提醒：规则配置与批次级事件
-- 事件先按“本地触发日”预排程为 PENDING，到点投递后变为 SENT。
-- PENDING/SENT 受唯一约束保护，重复扫描不会产生或重复发送同一事件。

CREATE TYPE reminder_event_type AS ENUM ('LOW_STOCK', 'EXPIRING_SOON', 'EXPIRED');
CREATE TYPE reminder_event_status AS ENUM ('PENDING', 'SENT', 'CANCELLED', 'SUPERSEDED');

CREATE TABLE reminder_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  low_stock_enabled boolean NOT NULL DEFAULT true,
  expiry_enabled boolean NOT NULL DEFAULT true,
  expiry_warning_days integer NOT NULL DEFAULT 30 CHECK (expiry_warning_days BETWEEN 0 AND 365),
  notify_time char(5) NOT NULL DEFAULT '09:00' CHECK (notify_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  -- 已完成日扫描的本地日期（按 timezone 计算），重复扫描同一天直接跳过
  last_scan_local_date date,
  last_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
INSERT INTO reminder_settings(id) VALUES (1);

-- 材料级临期阈值覆盖；为空时使用 reminder_settings.expiry_warning_days
ALTER TABLE materials
  ADD COLUMN expiry_warning_days integer CHECK (expiry_warning_days IS NULL OR expiry_warning_days BETWEEN 0 AND 365);

CREATE TABLE reminder_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  type reminder_event_type NOT NULL,
  status reminder_event_status NOT NULL DEFAULT 'PENDING',
  -- 规则去重指纹：
  --  LOW_STOCK    = 阈值数值（阈值变化产生新一轮事件）
  --  EXPIRING_*   = 有效期日期（有效期改期产生新一轮事件）
  fingerprint varchar(64) NOT NULL,
  trigger_date date NOT NULL,
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  -- 生成事件时的状态快照，供通知中心直接展示
  quantity_snapshot numeric(18,6),
  threshold_snapshot numeric(18,6),
  expiry_snapshot date,
  days_to_expiry integer,
  cancel_reason varchar(40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 同一批次同一类型同一轮规则，未终结的事件只允许一条（幂等核心）
CREATE UNIQUE INDEX reminder_events_active_uq
  ON reminder_events(batch_id, type, fingerprint)
  WHERE status IN ('PENDING', 'SENT');
CREATE INDEX reminder_events_status_scheduled_idx
  ON reminder_events(status, scheduled_for);
CREATE INDEX reminder_events_batch_idx
  ON reminder_events(batch_id, created_at DESC);
CREATE INDEX reminder_events_type_trigger_idx
  ON reminder_events(type, trigger_date);

CREATE TRIGGER reminder_settings_updated_at BEFORE UPDATE ON reminder_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reminder_events_updated_at BEFORE UPDATE ON reminder_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
