/* global document */
const { test, expect } = require('./fixtures');

test('a saved session keeps its dismiss button in the top-right corner when the card wraps', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  const box = await mainWindow.evaluate(() => {
    const item = document.createElement('div');
    item.className = 'task-item saved-session';
    item.innerHTML =
      '<span class="status-dot saved" aria-hidden="true"></span>' +
      '<span class="task-mode">CC</span>' +
      '<div class="saved-session-info">' +
        '<span class="task-name">klaussy-desktop-with-a-long-name</span>' +
        '<span class="saved-session-detail">testteststs · 2d ago</span>' +
      '</div>' +
      '<div class="saved-session-actions">' +
        '<button class="saved-session-resume">Resume</button>' +
        '<button class="saved-session-new">New</button>' +
      '</div>' +
      '<button class="saved-session-dismiss" aria-label="Dismiss saved session">×</button>';
    document.getElementById('task-list').appendChild(item);
    const card = item.getBoundingClientRect();
    const x = item.querySelector('.saved-session-dismiss').getBoundingClientRect();
    const actions = item.querySelector('.saved-session-actions').getBoundingClientRect();
    const name = item.querySelector('.task-name').getBoundingClientRect();
    item.remove();
    return {
      topGap: x.top - card.top,
      rightGap: card.right - x.right,
      aboveActions: x.bottom <= actions.top,
      clearOfName: name.right <= x.left,
    };
  });
  expect(box.topGap).toBeLessThanOrEqual(8);
  expect(box.rightGap).toBeLessThanOrEqual(8);
  expect(box.aboveActions).toBe(true);
  expect(box.clearOfName).toBe(true);
});
