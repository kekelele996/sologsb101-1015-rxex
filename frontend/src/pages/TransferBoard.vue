<script setup lang="ts">
/**
 * /transfers 古树管护责任划转
 * - 两边按古树编号对账发起划转：对得上的整株树（检查 / 措施 / 加固件）随树走并冻结；
 * - 对不上的编号先摆到「对账挂账」档案页等人工裁定；
 * - 接手方接收（改管护单位，历史复评结论留在原单位名下）或退回原单位继续办；
 * - 库内数据缺归属时先按现状回填，回填落实后才启用划转。
 * 消费模型：Transfer、TransferIssue、Tree；复用组件：<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useTransferStore } from '@/stores/transferStore'
import {
  TRANSFER_STATE_OPTIONS,
  type Transfer,
  type TransferDraft,
  type TransferIssue,
  type TransferIssueResolution,
  type TransferState,
} from '@/types/transfer'
import { parseCodes, reconcileByCode, type ReconcileResult } from '@/utils/transfer'
import { today } from '@/utils/id'

const treeStore = useTreeStore()
const transferStore = useTransferStore()
const router = useRouter()

const activeTab = ref<'transfers' | 'issues'>('transfers')
const stateFilter = ref<TransferState | 'all'>('all')

const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive<TransferDraft>({
  codesText: '',
  fromUnit: '',
  toUnit: '',
  date: today(),
})

const issueDialogVisible = ref(false)
const issueSubmitting = ref(false)
const editingIssue = ref<TransferIssue | null>(null)
const issueForm = reactive<{ resolution: Exclude<TransferIssueResolution, '待裁定'>; note: string }>({
  resolution: '不移交',
  note: '',
})

const treeByCode = computed<Record<string, { id: string; owner: string }>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.code, { id: tree.id, owner: tree.owner }]))
)

const treeById = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

/** 发起前实时对账预览 */
const reconcile = computed<ReconcileResult>(() =>
  reconcileByCode(parseCodes(form.codesText), treeStore.trees)
)

const filteredTransfers = computed<Transfer[]>(() =>
  stateFilter.value === 'all'
    ? transferStore.transfers
    : transferStore.transfers.filter((row) => row.state === stateFilter.value)
)

const counts = computed(() => {
  const pending = transferStore.transfers.filter((row) => row.state === '待接收').length
  const accepted = transferStore.transfers.filter((row) => row.state === '已接收').length
  const returned = transferStore.transfers.filter((row) => row.state === '已退回').length
  return { pending, accepted, returned }
})

onMounted(() => {
  void treeStore.loadAll()
  void transferStore.init()
})

function openCreate(): void {
  Object.assign(form, { codesText: '', fromUnit: '', toUnit: '', date: today() })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (parseCodes(form.codesText).length === 0) {
    ElMessage.warning('请先填写要划转的古树编号（换行或逗号分隔）')
    return
  }
  if (form.fromUnit.trim() === '' || form.toUnit.trim() === '') {
    ElMessage.warning('请填写移交单位与接手单位')
    return
  }
  submitting.value = true
  try {
    const result = await transferStore.createFromDraft({ ...form })
    ElMessage.success(
      `批次 ${result.batchNo} 已发起：${result.matched} 株对账一致并冻结，${result.issueCount} 个编号对不上已挂账等裁定`
    )
    dialogVisible.value = false
    activeTab.value = result.matched > 0 ? 'transfers' : 'issues'
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发起划转失败')
  } finally {
    submitting.value = false
  }
}

async function handleAccept(row: Transfer): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `确认接收「${row.treeCode}」？整棵树（树体检查、复壮措施、加固件）将整体划归「${row.toUnit}」；历史长势复评结论仍留在「${row.fromUnit}」名下，不会改写。`,
      '接手方确认接收',
      {
        confirmButtonText: '确认接收',
        cancelButtonText: '取消',
        inputPlaceholder: '可填写接收备注（选填）',
        inputValue: '',
      }
    )
    await transferStore.accept(row.id, value ?? '')
    ElMessage.success('已接收：管护单位已变更，历史复评结论归属保持不变')
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message)
  }
}

async function handleReturn(row: Transfer): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `确认把「${row.treeCode}」退还原单位「${row.fromUnit}」继续办？退回后冻结解除，管护单位不变。`,
      '接手方退回',
      {
        confirmButtonText: '确认退回',
        cancelButtonText: '取消',
        inputPlaceholder: '请填写退回原因',
        inputValue: '',
      }
    )
    if ((value ?? '').trim() === '') {
      ElMessage.warning('请填写退回原因')
      return
    }
    await transferStore.returnBack(row.id, value)
    ElMessage.success('已退还原单位继续办，冻结已解除')
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message)
  }
}

function openIssueDialog(row: TransferIssue): void {
  editingIssue.value = row
  // 档案无此编号不能并入，只能判不移交
  issueForm.resolution = row.kind === '档案无此编号' ? '不移交' : '并入移交'
  issueForm.note = ''
  issueDialogVisible.value = true
}

async function handleIssueSubmit(): Promise<void> {
  if (editingIssue.value === null) return
  issueSubmitting.value = true
  try {
    await transferStore.decideIssue(editingIssue.value.id, issueForm.resolution, issueForm.note)
    ElMessage.success(
      issueForm.resolution === '并入移交' ? '已裁定并入：生成一笔待接收划转' : '已裁定不移交，挂账关闭'
    )
    issueDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '裁定失败')
  } finally {
    issueSubmitting.value = false
  }
}

async function handleBackfill(): Promise<void> {
  const result = await transferStore.refreshBackfill()
  await treeStore.loadAll()
  if (result.treesBackfilled > 0 || result.reviewsBackfilled > 0) {
    ElMessage.success(`已按现状回填：古树 ${result.treesBackfilled} 株、复评结论 ${result.reviewsBackfilled} 条`)
  } else {
    ElMessage.info('没有需要回填的归属；仍有「未划分管护单位」的古树时请先在档案页落实')
  }
}

function stateTagType(state: TransferState): 'warning' | 'success' | 'info' {
  return state === '待接收' ? 'warning' : state === '已接收' ? 'success' : 'info'
}

function resolutionTagType(resolution: TransferIssueResolution): 'danger' | 'success' | 'info' {
  return resolution === '待裁定' ? 'danger' : resolution === '并入移交' ? 'success' : 'info'
}

function canMerge(row: TransferIssue | null | undefined): boolean {
  return row !== null && row !== undefined && row.resolution === '待裁定' && row.kind !== '档案无此编号'
}

function goTree(treeId: string): void {
  if (treeId === '') return
  treeStore.selectTree(treeId)
  void router.push(`/trees/${treeId}/surveys`)
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待接收（冻结中）" :value="counts.pending" suffix="株" tone="warning" icon="Warning" hint="待接收期间原单位与接手单位都不能修改这些树" />
      <StatBadge label="已接收" :value="counts.accepted" suffix="株" tone="success" icon="CircleCheck" />
      <StatBadge label="已退回" :value="counts.returned" suffix="株" tone="info" icon="RefreshLeft" />
      <StatBadge
        label="对账挂账待裁定"
        :value="transferStore.pendingIssueCount"
        suffix="笔"
        :tone="transferStore.pendingIssueCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="按编号对不上的记录，先摆到档案页等人工裁定"
      />
      <StatBadge label="划转单总数" :value="transferStore.transfers.length" suffix="笔" tone="primary" icon="Histogram" size="small" />
    </div>

    <el-alert
      v-if="!transferStore.ownershipReady"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      title="管护单位归属尚未全部落实，划转功能暂不可用"
    >
      <template #default>
        <div class="gate-line">
          <span>
            库里还有
            <b>{{ transferStore.backfill.unassignedTreeCount }}</b>
            株古树挂在「未划分管护单位」下。系统已在打开时按现状自动回填缺失归属；请在古树档案页把这些古树的管护单位落实后再发起划转。
          </span>
          <el-button size="small" type="primary" plain @click="handleBackfill">重新按现状回填归属</el-button>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">古树管护责任划转</span>
          <el-button type="primary" :disabled="!transferStore.ownershipReady" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>按编号发起划转</span>
          </el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane name="transfers">
          <template #label>
            <span>划转单（{{ transferStore.transfers.length }}）</span>
          </template>

          <div class="filter-row">
            <el-radio-group v-model="stateFilter" size="small">
              <el-radio-button label="all">全部</el-radio-button>
              <el-radio-button v-for="state in TRANSFER_STATE_OPTIONS" :key="state" :label="state">
                {{ state }}
              </el-radio-button>
            </el-radio-group>
          </div>

          <EmptyPanel
            v-if="transferStore.transfers.length === 0"
            title="还没有划转单"
            description="移交方按古树编号列出移交清单，系统与档案对账：对得上的整株树（树体检查、复壮措施、加固件）随树走，对不上的先挂账等裁定。"
            action-text="按编号发起划转"
            @action="openCreate"
          />

          <el-table v-else :data="filteredTransfers" row-key="id" stripe>
            <el-table-column label="批次 / 编号" min-width="200">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span class="mono">{{ row.batchNo }}</span>
                  <el-link type="primary" @click="goTree(row.treeId)">{{ row.treeCode }}</el-link>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="移交 → 接手" min-width="240">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span>{{ row.fromUnit }} → <b>{{ row.toUnit }}</b></span>
                  <span class="cell-sub">发起日期 {{ row.date }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="130">
              <template #default="{ row }">
                <el-tag :type="stateTagType(row.state)" effect="dark">{{ row.state }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="处理日期" width="120">
              <template #default="{ row }">{{ row.handledAt || '—' }}</template>
            </el-table-column>
            <el-table-column label="备注 / 退回原因" min-width="200">
              <template #default="{ row }">{{ row.note || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="200" fixed="right">
              <template #default="{ row }">
                <template v-if="row.state === '待接收'">
                  <el-button link type="success" size="small" @click="handleAccept(row)">接收</el-button>
                  <el-button link type="warning" size="small" @click="handleReturn(row)">退回</el-button>
                </template>
                <span v-else class="cell-sub">已办结</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="issues">
          <template #label>
            <span>对账挂账（{{ transferStore.issues.length }}<template v-if="transferStore.pendingIssueCount > 0"> · 待裁定 {{ transferStore.pendingIssueCount }}</template>）</span>
          </template>

          <el-alert
            v-if="transferStore.pendingIssueCount > 0"
            type="warning"
            show-icon
            :closable="false"
            class="mb-14"
            title="以下编号两边对账不一致，已摆到档案页等人工裁定"
            description="裁定「并入移交」会以档案现状归属生成一笔待接收划转；档案查无此树的只能裁定「不移交」。"
          />

          <EmptyPanel
            v-if="transferStore.issues.length === 0"
            title="没有对账挂账"
            description="按编号对不上的移交清单会记在这里：档案无此编号、清单漏列、或归属单位与清单不一致。"
          />

          <el-table v-else :data="transferStore.issues" row-key="id" stripe>
            <el-table-column label="批次 / 编号" min-width="190">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span class="mono">{{ row.batchNo }}</span>
                  <span>{{ row.treeCode }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="对不上的原因" width="150">
              <template #default="{ row }">
                <el-tag size="small" :type="row.kind === '档案无此编号' ? 'danger' : 'warning'">{{ row.kind }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="档案现状" min-width="200">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span v-if="treeById[row.treeId]">{{ treeById[row.treeId] }}（管护：{{ treeByCode[row.treeCode]?.owner ?? '—' }}）</span>
                  <span v-else class="cell-warn">档案中查无此树</span>
                  <span class="cell-sub">{{ row.fromUnit }} → {{ row.toUnit }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="detail" label="挂账说明" min-width="240" />
            <el-table-column label="裁定" width="150">
              <template #default="{ row }">
                <el-tag :type="resolutionTagType(row.resolution)" effect="plain">{{ row.resolution }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="裁定备注" min-width="180">
              <template #default="{ row }">{{ row.decisionNote || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.resolution === '待裁定'"
                  link
                  type="primary"
                  size="small"
                  @click="openIssueDialog(row)"
                >
                  裁定
                </el-button>
                <span v-else class="cell-sub">已裁定</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="dialogVisible" title="按编号发起管护划转" width="680px">
      <el-form label-width="110px">
        <el-form-item label="移交单位">
          <el-input v-model="form.fromUnit" placeholder="如：东城区园林绿化局（须与档案现状管护单位一致）" />
        </el-form-item>
        <el-form-item label="接手单位">
          <el-input v-model="form.toUnit" placeholder="如：北京中轴世界文化遗产管理中心" />
        </el-form-item>
        <el-form-item label="发起日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="古树编号清单">
          <el-input
            v-model="form.codesText"
            type="textarea"
            :rows="4"
            placeholder="逐行或用逗号分隔，如：&#10;京-01-0007&#10;京-05-0246"
          />
        </el-form-item>
      </el-form>

      <div class="reconcile-box">
        <div class="reconcile-title">对账预览（两边按古树编号核对）</div>
        <div class="reconcile-line">
          <el-tag type="success" size="small">对得上 {{ reconcile.matched.length }} 株</el-tag>
          <el-tag type="danger" size="small">档案无此编号 {{ reconcile.missingInArchive.length }} 个</el-tag>
        </div>
        <div v-if="reconcile.matched.length > 0" class="reconcile-detail">
          <span v-for="item in reconcile.matched" :key="item.code" class="code-chip code-chip--ok">
            {{ item.code }} · {{ item.owner }}
          </span>
        </div>
        <div v-if="reconcile.missingInArchive.length > 0" class="reconcile-detail">
          <span v-for="code in reconcile.missingInArchive" :key="code" class="code-chip code-chip--bad">
            {{ code }}（档案无此编号，将挂账）
          </span>
        </div>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          class="mt-10"
          title="归属单位与清单不符、或已有未结划转的树不会重复移交，会一并挂账等裁定；对得上的树发起后整株冻结，待接收 / 退回期间双方都不能修改。"
        />
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">对账并发起</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="issueDialogVisible" title="人工裁定对账挂账" width="560px">
      <div v-if="editingIssue" class="issue-ctx">
        <p><b>{{ editingIssue.treeCode }}</b> · {{ editingIssue.kind }}</p>
        <p class="cell-sub">{{ editingIssue.detail }}</p>
      </div>
      <el-form label-width="100px" class="mt-10">
        <el-form-item label="裁定结果">
          <el-radio-group v-model="issueForm.resolution">
            <el-radio value="并入移交" :disabled="!canMerge(editingIssue ?? undefined)">并入移交</el-radio>
            <el-radio value="不移交">不移交</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="裁定备注">
          <el-input v-model="issueForm.note" type="textarea" :rows="2" placeholder="说明裁定依据（并入时会记入划转单备注）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="issueSubmitting" @click="handleIssueSubmit">确认裁定</el-button>
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

.gate-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.filter-row {
  margin-bottom: 12px;
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
  color: #c0392b;
  font-weight: 600;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #8c8479;
}

.mb-14 {
  margin-bottom: 14px;
}

.mt-10 {
  margin-top: 10px;
}

.reconcile-box {
  margin-top: 6px;
  padding: 12px 14px;
  background: #faf8f2;
  border: 1px solid #e6e0d6;
  border-radius: 10px;
}

.reconcile-title {
  font-size: 13px;
  font-weight: 600;
  color: #2f2a24;
  margin-bottom: 8px;
}

.reconcile-line {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.reconcile-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.code-chip {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
}

.code-chip--ok {
  background: #eafaf1;
  color: #1e8449;
}

.code-chip--bad {
  background: #fdf3f2;
  color: #c0392b;
}

.issue-ctx p {
  margin: 4px 0;
}
</style>
