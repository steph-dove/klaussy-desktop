// ExitPlanMode plan-approval gate. The agent's plan-mode hook normally connects
// to a unix socket and main's plan-gate broadcasts a 'plan-approval-event' to
// every window, then blocks until the renderer answers via 'respond-plan-approval'.
// Rather than stand up the socket, we drive plan-gate directly in the MAIN
// process (handlePlanApprovalRequest with a no-op fake conn) so it broadcasts the
// real event, then assert the renderer modal renders the plan + file checklist and
// that #plan-approval-approve / #plan-approval-reject resolve the blocking promise
// through the real respondPlanApproval IPC. Each request uses a unique marker so
// concurrent app instances can't cross-talk.

const path = require('path');
const { test, expect } = require('./fixtures');

const planGatePath = path.resolve(__dirname, '..', 'main', 'state', 'plan-gate.js');

// Push a plan-approval request from inside main (uses the real plan-gate, which
// broadcasts 'plan-approval-event' to all windows). The blocking promise is parked
// on globalThis so we can await its resolution after the renderer responds.
async function pushPlanRequest(electronApp, planContent) {
  await electronApp.evaluate(({}, args) => {
    const planGate = process.mainModule.require(args.planGatePath);
    const conn = { on: () => {}, removeListener: () => {} };
    globalThis.__planPromise = planGate.handlePlanApprovalRequest(
      args.cwd, args.planContent, conn,
    );
  }, { planGatePath, cwd: '/tmp/plan-approval-e2e', planContent });
}

async function awaitPlanResult(electronApp) {
  return electronApp.evaluate(async () => await globalThis.__planPromise);
}

test('plan-approval modal renders plan + file checklist and APPROVE resolves the gate', async ({ electronApp, mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const marker = `APPROVE-${process.pid}-${Date.now()}`;
  await pushPlanRequest(electronApp, {
    raw: `PLAN ${marker}: build the widget`,
    files: ['src/widget.js', 'src/index.js'],
  });

  const overlay = mainWindow.locator('#plan-approval-overlay');
  await expect(overlay).toBeVisible();
  await expect(mainWindow.locator('#plan-approval-content')).toContainText(marker);

  // Declared files render as a checklist of labeled rows.
  const rows = mainWindow.locator('#plan-approval-checklist label');
  await expect(rows).toHaveCount(2);
  await expect(mainWindow.locator('#plan-approval-checklist')).toContainText('src/widget.js');

  await mainWindow.locator('#plan-approval-approve').click();

  // The blocking main-process promise resolves with approved=true and the modal closes.
  const result = await awaitPlanResult(electronApp);
  expect(result).toEqual({ approved: true });
  await expect(overlay).toBeHidden();
});

test('REJECT resolves the gate with approved=false', async ({ electronApp, mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const marker = `REJECT-${process.pid}-${Date.now()}`;
  await pushPlanRequest(electronApp, {
    raw: `PLAN ${marker}: do not proceed`,
    files: [],
  });

  const overlay = mainWindow.locator('#plan-approval-overlay');
  await expect(overlay).toBeVisible();
  await expect(mainWindow.locator('#plan-approval-content')).toContainText(marker);
  // Empty file list falls back to the "no specific files" notice.
  await expect(mainWindow.locator('#plan-approval-checklist')).toContainText('No specific files');

  await mainWindow.locator('#plan-approval-reject').click();

  const result = await awaitPlanResult(electronApp);
  expect(result).toEqual({ approved: false });
  await expect(overlay).toBeHidden();
});
