'use strict';

/**
 * Combined "Geography + Selected Reporters" approval scope — union behaviour, with
 * backward-compatibility for the existing geography-only and reporters-only scopes.
 */

const { getManagedReporterIds, buildPendingNewsFilterForSubEditor, subEditorHasTeamScope } = require('../utils/editorCoverageHelper');

const REPORTERS = [
  { _id: 'r1', assignedDistricts: ['Banda'] },   // matches district Banda
  { _id: 'r2', assignedDistricts: ['Agra'] },    // matches district Agra
  { _id: 'r3', assignedDistricts: ['Nowhere'] }, // matches nothing
];
const fakeAdmin = { find: () => ({ select: () => ({ lean: () => Promise.resolve(REPORTERS) }) }) };
const subEd = (perms) => ({ role: 'subeditor', permissions: Object.assign({ canApproveNews: true, canViewAllNews: false }, perms) });
const sortd = (a) => [...a].sort();

describe('getManagedReporterIds — union + backward compat', () => {
  test('geography-only → only geography-matched reporters (managedReporterIds ignored)', async () => {
    const ids = await getManagedReporterIds(fakeAdmin, subEd({ approvalScope: 'geography', managedDistricts: ['Banda'], managedReporterIds: ['rX'] }));
    expect(sortd(ids)).toEqual(['r1']);
  });

  test('reporters-only → only the selected reporters (geography ignored)', async () => {
    const ids = await getManagedReporterIds(fakeAdmin, subEd({ approvalScope: 'reporters', managedDistricts: ['Banda'], managedReporterIds: ['rX'] }));
    expect(sortd(ids)).toEqual(['rX']);
  });

  test('COMBINED → geography-matched UNION selected reporters', async () => {
    const ids = await getManagedReporterIds(fakeAdmin, subEd({ approvalScope: 'geography_and_reporters', managedDistricts: ['Banda', 'Agra'], managedReporterIds: ['rX', 'r1'] }));
    // r1 + r2 (geography) ∪ rX + r1 (explicit) → de-duped
    expect(sortd(ids)).toEqual(['r1', 'r2', 'rX']);
  });

  test('COMBINED with no geography → just the selected reporters', async () => {
    const ids = await getManagedReporterIds(fakeAdmin, subEd({ approvalScope: 'geography_and_reporters', managedDistricts: [], managedReporterIds: ['rX'] }));
    expect(sortd(ids)).toEqual(['rX']);
  });

  test('COMBINED with no selected reporters → just geography', async () => {
    const ids = await getManagedReporterIds(fakeAdmin, subEd({ approvalScope: 'geography_and_reporters', managedDistricts: ['Agra'], managedReporterIds: [] }));
    expect(sortd(ids)).toEqual(['r2']);
  });

  test("'all' scope unchanged → every active reporter", async () => {
    const ids = await getManagedReporterIds(fakeAdmin, subEd({ approvalScope: 'all' }));
    expect(sortd(ids)).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('team-scope + pending-news filter for combined', () => {
  test('subEditorHasTeamScope true when combined has only selected reporters', () => {
    expect(subEditorHasTeamScope(subEd({ approvalScope: 'geography_and_reporters', managedDistricts: [], managedReporterIds: ['rX'] }))).toBe(true);
  });
  test('subEditorHasTeamScope true when combined has only geography', () => {
    expect(subEditorHasTeamScope(subEd({ approvalScope: 'geography_and_reporters', managedDistricts: ['Banda'], managedReporterIds: [] }))).toBe(true);
  });
  test('pending-news filter for combined includes the geography location clause', async () => {
    const f = await buildPendingNewsFilterForSubEditor(fakeAdmin, subEd({ approvalScope: 'geography_and_reporters', managedDistricts: ['Banda'], managedReporterIds: ['rX'] }), {});
    const or = f.$or || (f.$and && f.$and[1] && f.$and[1].$or) || [];
    const hasLocation = or.some(c => c.location && c.location.$in && c.location.$in.includes('Banda'));
    const hasAuthor = or.some(c => c.authorId && c.authorId.$in);
    expect(hasLocation).toBe(true);   // geography still applies
    expect(hasAuthor).toBe(true);     // union reporter list applies
  });
});
