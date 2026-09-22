-- 低余量与临期提醒：批次级事件 + 单行规则设置

CREATE TYPE reminder_type AS ENUM ('LOW_STOCK', 'EXPIRY');
CREATE TYPE reminder_event_status AS ENUM ('PENDING', 'SENT', 'RESOLVED', 'CANCELLED');

CREATE TABLE reminder_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  notify_at_time char(5) NOT NULL DEFAULT '09:00' CHECK (notify_at_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  low_stock_enabled boolean NOT NULL DEFAULT true,
  expiry_enabled boolean NOT NULL DEFAULT true,
  expiry_lead_days integer[] NOT NULL DEFAULT '{30,7,3,1}'
    CHECK (cardinality(expiry_lead_days) BETWEEN 1 AND 10),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO reminder_settings(id) VALUES (1);

-- CHECK 约束不允许子查询：提前天数的取值范围与去重改用触发器校验。
CREATE OR REPLACE FUNCTION reminder_settings_validate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.expiry_lead_days) AS v WHERE v < 0 OR v > 3650) THEN
    RAISE EXCEPTION '临期提前天数必须在 0 到 3650 之间' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT v) FROM unnest(NEW.expiry_lead_days) AS v) <> cardinality(NEW.expiry_lead_days) THEN
    RAISE EXCEPTION '临期提前天数不能重复' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.notify_at_time !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
    RAISE EXCEPTION '通知时刻必须是 HH:MM 格式' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reminder_settings_validate_trg
  BEFORE INSERT OR UPDATE ON reminder_settings
  FOR EACH ROW EXECUTE FUNCTION reminder_settings_validate();

CREATE TABLE reminder_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type reminder_type NOT NULL,
  status reminder_event_status NOT NULL DEFAULT 'PENDING',
  batch_id uuid NOT NULL REFERENCES batches(id),
  material_id uuid NOT NULL REFERENCES materials(id),
  -- 幂等键：低余量 LOW_STOCK:{batchId}；临期 EXPIRY:{batchId}:{leadDays}
  dedup_key varchar(120) NOT NULL,
  lead_days integer,
  threshold_quantity numeric(18,6) CHECK (threshold_quantity IS NULL OR threshold_quantity >= 0),
  remaining_quantity numeric(18,6) CHECK (remaining_quantity IS NULL OR remaining_quantity >= 0),
  expiry_at date,
  title varchar(200) NOT NULL,
  body text NOT NULL,
  -- 计划发送时刻（UTC 存储，按设置时区与每日时刻换算）
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  read_at timestamptz,
  resolved_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason varchar(200),
  rule_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'EXPIRY') = (lead_days IS NOT NULL)),
  CHECK (status <> 'SENT' OR sent_at IS NOT NULL),
  CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);

-- 未终结事件（PENDING/SENT）按幂等键唯一：从数据库层面杜绝重复通知
CREATE UNIQUE INDEX reminder_events_active_uq
  ON reminder_events(dedup_key)
  WHERE status IN ('PENDING', 'SENT');

CREATE INDEX reminder_events_status_scheduled_idx
  ON reminder_events(status, scheduled_at);
CREATE INDEX reminder_events_batch_idx ON reminder_events(batch_id);
CREATE INDEX reminder_events_material_idx ON reminder_events(material_id);
CREATE INDEX reminder_events_type_status_idx ON reminder_events(type, status);

CREATE TRIGGER reminder_settings_updated_at BEFORE UPDATE ON reminder_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reminder_events_updated_at BEFORE UPDATE ON reminder_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 本地日历日 + IANA 时区 + HH:MM -> timestamptz。
-- 做法：先把墙钟时间按命名时区解释（AT TIME ZONE），再处理 DST 歧义/间隙：
-- 若解释结果回映到墙钟后与目标不一致（落在跳时间隙），顺延到本地墙钟重新对齐。
CREATE OR REPLACE FUNCTION timezone_trigger(trigger_date date, tz_name text, hh_mm char(5))
RETURNS timestamptz AS $$
DECLARE
  target timestamp without time zone := trigger_date + (split_part(hh_mm, ':', 1)::int * interval '1 hour')
                                                    + (split_part(hh_mm, ':', 2)::int * interval '1 minute');
  candidate timestamptz := target AT TIME ZONE tz_name;
  wall_back timestamp without time zone := candidate AT TIME ZONE tz_name;
BEGIN
  -- DST 春季跳时间隙：回映墙钟会比目标晚一个偏移差，此时用回映后的实际时刻（等价 GMT 侧规则）
  IF wall_back <> target THEN
    candidate := (target + (wall_back - target)) AT TIME ZONE tz_name;
  END IF;
  RETURN candidate;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
