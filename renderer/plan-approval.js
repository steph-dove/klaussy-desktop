window.PlanApproval = (function () {
  var overlay = document.getElementById('plan-approval-overlay');
  var contentEl = document.getElementById('plan-approval-content');
  var checklistEl = document.getElementById('plan-approval-checklist');
  var approveBtn = document.getElementById('plan-approval-approve');
  var rejectBtn = document.getElementById('plan-approval-reject');
  var errorEl = document.getElementById('plan-approval-error');

  var currentRequestId = null;

  function open(data) {
    if (!data || !data.requestId) return;
    currentRequestId = data.requestId;
    errorEl.textContent = '';

    // Set raw plan description
    const plan = data.planContent || data.plan || {};
    contentEl.textContent = plan.raw || plan.rationale || JSON.stringify(plan, null, 2);

    // Build files checklist
    checklistEl.innerHTML = '';
    const files = plan.files || [];
    if (files.length === 0) {
      const none = document.createElement('div');
      none.style.color = 'var(--text-muted)';
      none.style.fontSize = '13px';
      none.textContent = 'No specific files declared in plan (standard text plan).';
      checklistEl.appendChild(none);
    } else {
      files.forEach(function (f) {
        var label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.gap = '8px';
        label.style.fontSize = '13px';
        label.style.cursor = 'pointer';
        label.style.color = 'var(--text)';

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        
        var span = document.createElement('span');
        span.textContent = f;
        span.style.fontFamily = 'var(--font-mono)';

        label.appendChild(cb);
        label.appendChild(span);
        checklistEl.appendChild(label);
      });
    }

    overlay.style.display = 'flex';
  }

  function close() {
    overlay.style.display = 'none';
    currentRequestId = null;
  }

  async function handleResponse(approved) {
    if (!currentRequestId) return;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      var res = await window.klaus.task.respondPlanApproval(currentRequestId, approved);
      if (res && res.error) {
        errorEl.textContent = res.error;
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
      } else {
        close();
      }
    } catch (e) {
      errorEl.textContent = e.message;
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  }

  if (overlay) {
    approveBtn.addEventListener('click', function () {
      handleResponse(true);
    });

    rejectBtn.addEventListener('click', function () {
      handleResponse(false);
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        handleResponse(false);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (overlay.style.display === 'none') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        handleResponse(false);
      }
    });
  }

  // Register main process listener if task IPC is available
  if (window.klaus && window.klaus.task && window.klaus.task.onPlanApprovalEvent) {
    window.klaus.task.onPlanApprovalEvent(function (data) {
      if (data && data.type === 'request') {
        open(data);
      }
    });
  }

  return {
    open: open,
    close: close
  };
})();
