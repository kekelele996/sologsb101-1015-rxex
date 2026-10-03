<script setup lang="ts">
/**
 * /transfers 管护划转
 * 古树管护责任在养护单位之间划转：整棵树连同检查 / 措施 / 加固件交给接手单位，
 * 长势复评结论留在原单位名下。两边按树的编号对账，对不上的摆到档案页等人裁定；
 * 接手方没接稳的部分退还原单位继续办。划转期间锁定古树，两边不能同时改同一株树。
 * 消费模型：TransferRecord、Tree；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useTransferStore } from '@/stores/transferStore'
import {
  TRANSFER_STATUS_LABEL,
  TRANSFER_STATUS_TAG_TYPE,
  type TransferRecord,
  type TransferStatus,
} from '@/types/transfer'

const treeStore = useTreeStore()
const transferStore = useTransferStore()

const keyword = ref('')
const statusFilter = ref<TransferStatus | 'all'>('all')

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  treeId: '',
  toOwner: '',
  note: '',
})

const rules: FormRules = {
  treeId: [{ required: true, message: '请选择划转的古树', trigger: 'change' }],
  toOwner: [{ required: true, message: '请填写接手单位', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const filtered = computed<TransferRecord[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return treeStore.transfers
    .filter((row) => {
      if (statusFilter.value !== 'all' && row.status !== statusFilter.value) return false
      if (key === '') return true
      return (
        row.treeCode.toLowerCase().includes(key) ||
        row.fromOwner.toLowerCase().includes(key) ||
        row.toOwner.toLowerCase().includes(key) ||
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})

const pendingCount = computed(() => treeStore.pendingTransfers.length)
const adjudicatingCount = computed(() => treeStore.adjudicatingTransfers.length)
const acceptedCount = computed(() => treeStore.transfers.filter((row) => row.status === 'accepted').length)
const rejectedCount = computed(() => treeStore.transfers.filter((row) => row.status === 'rejected').length)

onMounted(() => {
  void treeStore.loadAll()
  void transferStore.init()
})

function openCreate(): void {
  Object.assign(form, {
    treeId: treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '',
    toOwner: '',
    note: '',
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const record = await transferStore.initiate(form.treeId, form.toOwner, form.note)
    if (record === null) {
      ElMessage.error(transferStore.lastMessage || '发起划转失败')
      return
    }
    ElMessage.success(`已发起「${record.treeCode}」的管护划转，等待接手单位确认`)
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发起划转失败')
  } finally {
    submitting.value = false
  }
}

async function handleAccept(row: TransferRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认接手「${row.treeCode} ${row.treeSpecies}」？古树及树体检查、复壮措施、加固件随树划转到贵单位；原单位的长势复评结论留在原单位名下。`,
      '确认接手？',
      { type: 'warning', confirmButtonText: '确认接手', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await transferStore.accept(row.id)
  if (ok) ElMessage.success('已确认接手，古树管护责任已划转')
  else ElMessage.error(transferStore.lastMessage || '接手失败')
}

async function handleReject(row: TransferRecord): Promise<void> {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt('请填写退回原因（没接稳的部分退还原单位继续办）', '退回划转', {
      confirmButtonText: '确认退回',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '如：本年度透气措施尚未实施完成，退回原单位继续办理',
    })
    reason = result.value
  } catch {
    return
  }
  const ok = await transferStore.reject(row.id, reason)
  if (ok) ElMessage.success('已退回，古树仍归原单位管护')
  else ElMessage.error(transferStore.lastMessage || '退回失败')
}

async function handleMismatch(row: TransferRecord): Promise<void> {
  let note = ''
  try {
    const result = await ElMessageBox.prompt('两边按树的编号对账，请填写对不上的地方（将摆到档案页等人裁定）', '对账对不上', {
      confirmButtonText: '标记对不上',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '如：编号为京-01-0007 的古树，原单位台账有 3 次检查记录，接手方只收到 2 次',
    })
    note = result.value
  } catch {
    return
  }
  const ok = await transferStore.mismatch(row.id, note)
  if (ok) ElMessage.success('已标记为对账对不上，摆在档案页等人裁定')
  else ElMessage.error(transferStore.lastMessage || '标记失败')
}

async function handleAdjudicateAccept(row: TransferRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `裁定「${row.treeCode}」的对账争议：确认接手？接手后古树及检查 / 措施 / 加固件随树划转。`,
      '裁定：确认接手？',
      { type: 'warning', confirmButtonText: '裁定接手', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await transferStore.adjudicateAccept(row.id)
  if (ok) ElMessage.success('裁定：确认接手')
  else ElMessage.error(transferStore.lastMessage || '裁定失败')
}

async function handleAdjudicateReject(row: TransferRecord): Promise<void> {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt('裁定退回，请填写退回原因', '裁定：退回原单位', {
      confirmButtonText: '裁定退回',
      cancelButtonText: '取消',
      inputType: 'textarea',
    })
    reason = result.value
  } catch {
    return
  }
  const ok = await transferStore.adjudicateReject(row.id, reason)
  if (ok) ElMessage.success('裁定：退回原单位继续办')
  else ElMessage.error(transferStore.lastMessage || '裁定失败')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'status') statusFilter.value = value as TransferStatus | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待接手" :value="pendingCount" suffix="项" tone="warning" icon="Warning" />
      <StatBadge
        label="待裁定"
        :value="adjudicatingCount"
        suffix="项"
        :tone="adjudicatingCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="两边按编号对账对不上，摆在档案页等人裁定"
      />
      <StatBadge label="已接手" :value="acceptedCount" suffix="项" tone="success" icon="DataLine" />
      <StatBadge label="已退回" :value="rejectedCount" suffix="项" tone="info" icon="RefreshLeft" />
      <StatBadge label="划转总数" :value="treeStore.transfers.length" suffix="项" tone="primary" icon="Histogram" />
    </div>

    <el-alert
      v-if="adjudicatingCount > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${adjudicatingCount} 项划转两边按编号对账对不上，已摆在档案页等人裁定`"
      description="对账争议期间古树保持锁定，两边不能同时改同一株树。裁定后按结果接手或退回。"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">管护划转台账</span>
          <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>发起划转</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[{ key: 'status', label: '状态', options: TRANSFER_STATUS_LABEL as unknown as string[] }]"
        :values="{ status: statusFilter }"
        :result-text="`命中 ${filtered.length} / ${treeStore.transfers.length} 项`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            keyword = ''
            statusFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="treeStore.transfers.length === 0"
        title="还没有管护划转记录"
        description="发起划转后，整棵古树连同树体检查、复壮措施、加固件一起交给接手单位；长势复评结论留在原单位名下。"
        action-text="发起第一项划转"
        @action="openCreate"
      />

      <el-table v-else v-loading="!treeStore.ready" :data="filtered" row-key="id" stripe>
        <el-table-column label="古树编号 / 树种" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="code-text">{{ row.treeCode }}</span>
              <span class="cell-sub">{{ row.treeSpecies }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="原单位 → 接手单位" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.fromOwner }}</span>
              <span class="cell-sub">→ {{ row.toOwner }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="随树划转" width="180">
          <template #default="{ row }">
            <span class="cell-sub">
              检查 {{ row.surveyCount }} · 措施 {{ row.measureCount }} · 加固 {{ row.supportCount }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }: { row: TransferRecord }">
            <el-tag :type="TRANSFER_STATUS_TAG_TYPE[row.status]" effect="dark">
              {{ TRANSFER_STATUS_LABEL[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对账说明" min-width="200">
          <template #default="{ row }">
            <span v-if="row.mismatchNote" class="cell-warn">{{ row.mismatchNote }}</span>
            <span v-else-if="row.note" class="cell-sub">{{ row.note }}</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="发起时间" width="170">
          <template #default="{ row }">
            <span class="cell-sub">{{ row.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button link type="success" size="small" @click="handleAccept(row)">接手</el-button>
              <el-button link type="warning" size="small" @click="handleMismatch(row)">对不上</el-button>
              <el-button link type="danger" size="small" @click="handleReject(row)">退回</el-button>
            </template>
            <template v-else-if="row.status === 'adjudicating'">
              <el-button link type="success" size="small" @click="handleAdjudicateAccept(row)">裁定接手</el-button>
              <el-button link type="danger" size="small" @click="handleAdjudicateReject(row)">裁定退回</el-button>
            </template>
            <span v-else class="cell-sub">已处理</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="发起管护划转" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="划转古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.owner}`"
              :disabled="treeStore.isTreeLocked(tree.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="接手单位" prop="toOwner">
          <el-input v-model="form.toOwner" placeholder="如：朝阳区公园管理中心" />
        </el-form-item>
        <el-form-item label="划转备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选：说明划转背景与随树移交的资料" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="整棵古树连同树体检查、复壮措施、加固件一起交给接手单位；原单位已经定过的长势复评结论留在原单位名下，不被改写。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">发起划转</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-warn {
  font-size: 12px;
  color: #c0392b;
}

.code-text {
  font-weight: 600;
  color: #2f2a24;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
