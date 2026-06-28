const { allWindows } = require('./windows');

const pendingApprovals = new Map();
let nextRequestId = 1;

function notifyWindows(channel, payload) {
  try {
    for (const w of allWindows) {
      if (w && !w.isDestroyed()) {
        w.webContents.send(channel, payload);
      }
    }
  } catch (e) {
    console.warn('[plan-gate] notifyWindows failed:', e.message);
  }
}

function handlePlanApprovalRequest(cwd, planContent, conn) {
  const requestId = 'plan-req-' + nextRequestId++;
  console.log(`[plan-gate] Received plan approval request: ${requestId} for ${cwd}`);

  const promise = new Promise((resolve) => {
    const cleanup = () => {
      if (pendingApprovals.has(requestId)) {
        console.log(`[plan-gate] Client disconnected prematurely: ${requestId}`);
        pendingApprovals.delete(requestId);
        resolve({ approved: false });
      }
    };
    conn.on('close', cleanup);
    conn.on('error', cleanup);

    pendingApprovals.set(requestId, {
      conn,
      resolve,
      cwd,
      planContent,
      cleanup
    });
  });

  // Broadcast event to renderer UI
  notifyWindows('plan-approval-event', {
    type: 'request',
    requestId,
    cwd,
    planContent
  });

  return promise;
}

function respondToPlanApproval(requestId, approved) {
  console.log(`[plan-gate] Responding to plan approval: ${requestId} -> ${approved}`);
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    return { error: 'Request not found or already handled' };
  }

  pendingApprovals.delete(requestId);
  
  // Clean up socket listeners
  pending.conn.removeListener('close', pending.cleanup);
  pending.conn.removeListener('error', pending.cleanup);

  // Resolve wait loop returning to client socket
  pending.resolve({ approved });
  return { ok: true };
}

module.exports = {
  handlePlanApprovalRequest,
  respondToPlanApproval
};
