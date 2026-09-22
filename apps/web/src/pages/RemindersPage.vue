<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Bell } from "@element-plus/icons-vue";
import { request, ApiError } from "@/lib/api";
import { reminderStatusLabels, reminderTypeLabels, type ApiMeta, type ReminderEvent, type ReminderSettings } from "@/types";

const loading = ref(false);
const saving = ref(false);
const reconciling = ref(false);
const rows = ref<ReminderEvent[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ type: "", status: "", active: "true" });
const settings = ref<ReminderSettings | null>(null);
const leadDaysInput = ref("30, 7, 3, 1");
const timezoneOptions = ref<{ value: string }[]>([]);
const summary = ref({ pendingCount: 0, unreadCount: 0, activeLowStockCount: 0, activeExpiryCount: 0 });

async function loadSummary() {
  try {
    const response = await request<{ data: typeof summary.value }>("/reminders/events/summary");
    summary.value = response.data;
  } catch {
    // 汇总仅用于展示角标，失败不阻塞页面
  }
}

async function loadSettings() {
  const response = await request<{ data: ReminderSettings }>("/reminders/settings");
  settings.value = response.data;
  leadDaysInput.value = response.data.expiryLeadDays.join(", ");
}

async function loadEvents(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: ReminderEvent[]; meta: ApiMeta }>(`/reminders/events?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "提醒事件加载失败");
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  if (!settings.value) return;
  const days = Array.from(
    new Set(
      leadDaysInput.value
        .split(/[,,\s]+/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value))
    )
  ).sort((a, b) => b - a);
  if (days.length === 0) {
    ElMessage.error("请至少配置一个临期提前天数");
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: ReminderSettings }>("/reminders/settings", {
      method: "PUT",
      body: {
        timezone: settings.value.timezone,
        notifyAtTime: settings.value.notifyAtTime,
        lowStockEnabled: settings.value.lowStockEnabled,
        expiryEnabled: settings.value.expiryEnabled,
        expiryLeadDays: days
      }
    });
    settings.value = response.data;
    leadDaysInput.value = response.data.expiryLeadDays.join(", ");
    ElMessage.success("规则已保存，未发送的提醒已按新规则重算");
    await Promise.all([loadEvents(1), loadSummary()]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "规则保存失败");
  } finally {
    saving.value = false;
  }
}

async function reconcileNow() {
  reconciling.value = true;
  try {
    const response = await request<{ data: Record<string, number> }>("/reminders/reconcile", { method: "POST" });
    const c = response.data;
    ElMessage.success(`重算完成：新增 ${c.inserted ?? 0}、改期 ${c.rescheduled ?? 0}、取消 ${c.cancelled ?? 0}、解除 ${c.resolved ?? 0}`);
    await Promise.all([loadEvents(meta.page), loadSummary()]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "重算失败");
  } finally {
    reconciling.value = false;
  }
}

async function markRead(row: ReminderEvent) {
  try {
    await request(`/reminders/events/${row.id}/read`, { method: "POST" });
    row.readAt = new Date().toISOString();
    await loadSummary();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "标记失败");
  }
}

onMounted(async () => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  timezoneOptions.value = supported.map((value) => ({ value }));
  try {
    await loadSettings();
    await Promise.all([loadEvents(1), loadSummary()]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "提醒数据加载失败");
  }
});
</script>

<template>
  <div>
    <header class="page-header">
      <div>
        <h1><el-icon><Bell /></el-icon> 低余量与临期提醒</h1>
        <p>按操作员时区在每日固定时刻生成批次级事件；重复扫描不会重复通知，规则变更只重算未发项。</p>
      </div>
      <el-button type="primary" :loading="reconciling" @click="reconcileNow">立即重算</el-button>
    </header>

    <section class="stat-grid" style="margin-bottom: 16px">
      <article class="stat-card"><small>待发送（到达时刻将自动通知）</small><strong>{{ summary.pendingCount }}</strong></article>
      <article class="stat-card"><small>已通知未读</small><strong>{{ summary.unreadCount }}</strong></article>
      <article class="stat-card"><small>未终结低余量事件</small><strong>{{ summary.activeLowStockCount }}</strong></article>
      <article class="stat-card"><small>未终结临期事件</small><strong>{{ summary.activeExpiryCount }}</strong></article>
    </section>

    <section class="panel" v-if="settings">
      <h2>提醒规则</h2>
      <el-form label-position="top" class="form-grid">
        <el-form-item label="时区（按本地日历日判定到期与发送时刻）">
          <el-select v-model="settings.timezone" filterable allow-create style="width: 100%">
            <el-option v-for="tz in timezoneOptions" :key="tz.value" :label="tz.value" :value="tz.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="每日通知时刻（时区本地时间）">
          <el-time-picker v-model="settings.notifyAtTime" format="HH:mm" value-format="HH:mm" :clearable="false" />
        </el-form-item>
        <el-form-item label="低余量提醒（批次余量 ≤ 材料低余量阈值）">
          <el-switch v-model="settings.lowStockEnabled" active-text="开启" inactive-text="关闭" />
        </el-form-item>
        <el-form-item label="临期提醒（批次有有效期且仍有库存）">
          <el-switch v-model="settings.expiryEnabled" active-text="开启" inactive-text="关闭" />
        </el-form-item>
        <el-form-item class="full" label="临期提前天数（逗号分隔，每个档位只通知一次；0 表示到期当天）">
          <el-input v-model="leadDaysInput" placeholder="30, 7, 3, 1" />
        </el-form-item>
        <el-form-item class="full">
          <el-button type="primary" :loading="saving" @click="saveSettings">保存并重算未发项</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="loadEvents(1)">
        <el-form-item label="类型">
          <el-select v-model="filters.type" clearable placeholder="全部" style="width: 130px">
            <el-option value="LOW_STOCK" label="低余量" />
            <el-option value="EXPIRY" label="临期" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px">
            <el-option v-for="(label, value) in reminderStatusLabels" :key="value" :value="value" :label="label" />
          </el-select>
        </el-form-item>
        <el-form-item label="视图">
          <el-select v-model="filters.active" style="width: 150px">
            <el-option value="true" label="仅未终结（待发送/已通知）" />
            <el-option value="" label="全部含历史" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadEvents(1)">筛选</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'PENDING' ? 'warning' : row.status === 'SENT' ? 'success' : 'info'">
              {{ reminderStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">{{ reminderTypeLabels[row.type] || row.type }}</template>
        </el-table-column>
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">
            <router-link :to="`/batches/${row.batchId}`"><strong>{{ row.materialName }}</strong></router-link>
            <div class="muted">{{ row.batchCode || "无批次号" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="内容" min-width="320">
          <template #default="{ row }">
            <div>{{ row.body }}</div>
            <div class="muted" style="font-size: 12px">
              计划 {{ new Date(row.scheduledAt).toLocaleString() }}
              <template v-if="row.status === 'CANCELLED'">· 取消原因：{{ row.cancelReason }}</template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="已读" width="90">
          <template #default="{ row }">
            <el-button v-if="row.sentAt && !row.readAt" link type="primary" @click="markRead(row)">标记已读</el-button>
            <span v-else-if="row.readAt" class="muted">已读</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="没有符合条件的提醒事件" />
      <el-pagination
        v-if="meta.total > 0"
        style="margin-top: 16px; justify-content: flex-end"
        layout="total, prev, pager, next"
        :total="meta.total"
        :page-size="meta.pageSize"
        :current-page="meta.page"
        @current-change="loadEvents"
      />
    </section>
  </div>
</template>
