<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { ApiMeta, ReminderEvent, ReminderSettings, ReminderSummary } from "@/types";
import { reminderStatusLabels, reminderTypeLabels } from "@/types";

const loading = ref(false);
const savingSettings = ref(false);
const reconciling = ref(false);
const rows = ref<ReminderEvent[]>([]);
const summary = ref<ReminderSummary | null>(null);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ type: "", status: "", archived: "false" });

const settings = reactive({
  timezone: "Asia/Shanghai",
  lowStockEnabled: true,
  expiryEnabled: true,
  expiryWarningDays: 30,
  notifyTime: "09:00",
  version: 1,
  lastScanLocalDate: null as string | null
});

const commonTimezones = [
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Taipei",
  "Asia/Bangkok", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Berlin",
  "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles",
  "America/Sao_Paulo", "Australia/Sydney", "UTC"
];

async function loadSettings() {
  try {
    const response = await request<{ data: ReminderSettings }>("/reminder-settings");
    Object.assign(settings, response.data);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "提醒配置加载失败");
  }
}

async function saveSettings() {
  savingSettings.value = true;
  try {
    const response = await request<{ data: ReminderSettings }>("/reminder-settings", {
      method: "PATCH",
      body: {
        timezone: settings.timezone,
        lowStockEnabled: settings.lowStockEnabled,
        expiryEnabled: settings.expiryEnabled,
        expiryWarningDays: settings.expiryWarningDays,
        notifyTime: settings.notifyTime,
        version: settings.version
      }
    });
    Object.assign(settings, response.data);
    ElMessage.success("提醒规则已保存，未发送的事件已按新规则重算");
    await load(1);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "保存失败");
  } finally {
    savingSettings.value = false;
  }
}

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20", archived: filters.archived });
    for (const [key, value] of Object.entries(filters)) if (value && key !== "archived") params.set(key, value);
    const [events, summaryResponse] = await Promise.all([
      request<{ data: ReminderEvent[]; meta: ApiMeta }>(`/reminder-events?${params}`),
      request<{ data: ReminderSummary }>("/reminder-events/summary")
    ]);
    rows.value = events.data;
    Object.assign(meta, events.meta);
    summary.value = summaryResponse.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "提醒事件加载失败");
  } finally {
    loading.value = false;
  }
}

async function reconcileNow() {
  reconciling.value = true;
  try {
    const response = await request<{ data: Record<string, number> }>("/reminders/reconcile", { method: "POST" });
    const stats = response.data;
    ElMessage.success(`重算完成：新增 ${stats.inserted}，取消 ${stats.cancelled}，终结 ${stats.superseded}，投递 ${stats.delivered}`);
    await Promise.all([loadSettings(), load(1)]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "重算失败");
  } finally {
    reconciling.value = false;
  }
}

function tagType(row: ReminderEvent): "danger" | "warning" | "info" | "success" | "primary" {
  if (row.status === "CANCELLED" || row.status === "SUPERSEDED") return "info";
  if (row.type === "EXPIRED") return "danger";
  if (row.type === "EXPIRING_SOON") return "warning";
  return "primary";
}

function detail(row: ReminderEvent): string {
  if (row.type === "LOW_STOCK") {
    return `剩余 ${row.quantitySnapshot ?? ""} / 阈值 ${row.thresholdSnapshot ?? ""} ${row.stockUnit}`;
  }
  return row.type === "EXPIRED"
    ? `已于 ${row.expirySnapshot ?? ""} 到期`
    : `有效期 ${row.expirySnapshot ?? ""}`;
}

onMounted(async () => {
  await loadSettings();
  await load(1);
});
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1>低余量与临期提醒</h1>
        <p>按操作员时区与材料阈值生成批次级事件；同一批次同一轮规则只通知一次。规则变更后仅重算未发送项，已通知的不会重复发送。</p>
      </div>
      <el-button :loading="reconciling" @click="reconcileNow">立即重算并投递</el-button>
    </header>

    <section class="stat-grid">
      <article class="stat-card"><small>待发送</small><strong>{{ summary?.pending ?? 0 }}</strong></article>
      <article class="stat-card"><small>今日已通知</small><strong>{{ summary?.sentToday ?? 0 }}</strong></article>
      <article class="stat-card"><small>低余量活动事件</small><strong>{{ summary?.lowStock ?? 0 }}</strong></article>
      <article class="stat-card"><small>临期活动事件</small><strong>{{ summary?.expiring ?? 0 }}</strong></article>
      <article class="stat-card"><small>已过期活动事件</small><strong>{{ summary?.expired ?? 0 }}</strong></article>
    </section>

    <section class="panel" style="margin-top: 16px">
      <h2>提醒规则</h2>
      <el-form label-position="top" style="max-width: 720px">
        <div class="form-grid">
          <el-form-item label="操作员时区">
            <el-select v-model="settings.timezone" filterable allow-create style="width: 100%" placeholder="IANA 时区，例如 Asia/Shanghai">
              <el-option v-for="tz in commonTimezones" :key="tz" :value="tz" :label="tz" />
            </el-select>
          </el-form-item>
          <el-form-item label="每日通知时间（当地时间）">
            <el-time-picker v-model="settings.notifyTime" format="HH:mm" value-format="HH:mm" style="width: 100%" />
          </el-form-item>
          <el-form-item label="全局临期提前天数">
            <el-input-number v-model="settings.expiryWarningDays" :min="0" :max="365" controls-position="right" style="width: 100%" />
          </el-form-item>
          <el-form-item label="开关">
            <el-checkbox v-model="settings.lowStockEnabled">低余量提醒</el-checkbox>
            <el-checkbox v-model="settings.expiryEnabled">临期/过期提醒</el-checkbox>
          </el-form-item>
        </div>
        <div style="display:flex;align-items:center;gap:16px">
          <el-button type="primary" :loading="savingSettings" @click="saveSettings">保存并立即重算</el-button>
          <span class="muted" v-if="settings.lastScanLocalDate">上次日扫描：{{ settings.lastScanLocalDate }}（{{ settings.timezone }}）</span>
        </div>
      </el-form>
    </section>

    <section class="toolbar" style="margin-top: 16px">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="类型">
          <el-select v-model="filters.type" clearable placeholder="全部" style="width: 140px">
            <el-option v-for="(label, value) in reminderTypeLabels" :key="value" :value="value" :label="label" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 140px">
            <el-option v-for="(label, value) in reminderStatusLabels" :key="value" :value="value" :label="label" />
          </el-select>
        </el-form-item>
        <el-form-item label="范围">
          <el-switch v-model="filters.archived" active-value="true" inactive-value="false" active-text="含已终结/取消" inactive-text="仅活动" />
        </el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">筛选</el-button></el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="类型" width="100">
          <template #default="{ row }"><el-tag :type="tagType(row)" size="small">{{ reminderTypeLabels[row.type] || row.type }}</el-tag></template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'PENDING' ? 'warning' : 'info'" size="small" effect="plain">
              {{ reminderStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="材料 / 批次" min-width="200">
          <template #default="{ row }">
            <router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link>
            <div class="muted">{{ row.batchCode || "无批次号" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="事件内容" min-width="200"><template #default="{ row }">{{ detail(row) }}</template></el-table-column>
        <el-table-column label="触发日" prop="triggerDate" width="120" />
        <el-table-column label="排程时刻" width="180"><template #default="{ row }">{{ new Date(row.scheduledFor).toLocaleString() }}</template></el-table-column>
        <el-table-column label="通知时刻" width="180">
          <template #default="{ row }">{{ row.sentAt ? new Date(row.sentAt).toLocaleString() : "—" }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="暂无提醒事件" />
      <el-pagination
        v-if="meta.total > 0"
        style="margin-top: 16px; justify-content: flex-end"
        layout="total, prev, pager, next"
        :total="meta.total"
        :page-size="meta.pageSize"
        :current-page="meta.page"
        @current-change="load"
      />
    </section>
  </div>
</template>
