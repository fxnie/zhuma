/** Contract test: empty section titles omit a zero count. Markup rendering is not Mac GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectHub } from '../dist/workbench/ProjectHub.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function hub(tab, project, state) {
  return renderToStaticMarkup(
    createElement(ProjectHub, {
      project,
      state,
      tab,
      changeTab() {},
      openTask() {},
      createTask() {},
      edit() {},
    }),
  );
}

test('section titles omit a zero count and keep a positive count', () => {
  const data = fixture();
  const emptyProject = { ...data.state.projects[0], defaultParticipantIds: [] };
  const emptyState = { ...data.state, tasks: [] };
  for (const [tab, title] of [
    ['people', '默认参与者'],
    ['overview', '最近更新的工作'],
    ['overview', '默认参与者'],
    ['work', '项目工作'],
  ]) {
    const html = hub(tab, emptyProject, emptyState);
    assert.match(html, new RegExp(`<h2>${title} ?</h2>`), title);
    assert.doesNotMatch(html, /<small>0<\/small>/, title);
    assert.doesNotMatch(html, new RegExp(`${title}。`), title);
  }
  assert.match(
    hub('people', data.state.projects[0], data.state),
    /<h2>默认参与者 <small>3<\/small><\/h2>/,
  );
  assert.match(
    hub('work', data.state.projects[0], data.state),
    /<h2>项目工作 <small>1<\/small><\/h2>/,
  );
  assert.match(
    hub('overview', data.state.projects[0], data.state),
    /<h2>最近更新的工作 <small>1<\/small><\/h2>/,
  );
});
