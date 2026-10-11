'use strict';

const { applyReporterCoverageFields } = require('../utils/editorCoverageHelper');

// A reporter previously on a broad AP "all districts / all locations" scope,
// now being re-assigned by the Edit Member form to Telangana → Khammam.
function staleEditor() {
  return {
    assignedStates: ['Andhra Pradesh'],
    assignedState: 'Andhra Pradesh',
    assignedDistricts: [],
    assignedConstituencies: [],
    constituency: 'Vijayawada',
    location: 'Andhra Pradesh',
    assignedLocations: ['Andhra Pradesh', 'Anakapalli', 'Guntur', 'Krishna', 'Visakhapatnam'],
  };
}

describe('applyReporterCoverageFields — Edit Member save is a REPLACEMENT', () => {
  test('structured selection replaces the old broad scope (no "+28" carry-forward)', () => {
    const editor = staleEditor();
    // Exactly what the Edit Member form sends (no assignedLocations).
    applyReporterCoverageFields(editor, {
      assignedStates: ['Telangana'],
      assignedDistricts: ['Khammam'],
      assignedConstituencies: [],
    });
    expect(editor.assignedState).toBe('Telangana');
    expect(editor.assignedStates).toEqual(['Telangana']);
    expect(editor.assignedDistricts).toEqual(['Khammam']);
    expect(editor.assignedLocations).toEqual(['Telangana', 'Khammam']); // old AP scope gone
    expect(editor.location).toBe('Khammam');
    expect(editor.constituency).toBeNull(); // stale other-state constituency cleared
  });

  test('explicit assignedLocations from a caller is honoured as-is', () => {
    const editor = staleEditor();
    applyReporterCoverageFields(editor, {
      assignedStates: ['Telangana'],
      assignedDistricts: ['Khammam'],
      assignedConstituencies: [],
      assignedLocations: ['Custom Place'],
    });
    expect(editor.assignedLocations).toEqual(['Telangana', 'Khammam', 'Custom Place']);
  });

  test('legacy-only update (no structured fields) keeps backward-compatible carry-forward', () => {
    const editor = staleEditor();
    applyReporterCoverageFields(editor, {}); // nothing structured supplied
    // states become empty (none supplied) but legacy locations are preserved.
    expect(editor.assignedLocations).toEqual(
      expect.arrayContaining(['Anakapalli', 'Guntur', 'Krishna', 'Visakhapatnam'])
    );
    expect(editor.constituency).toBe('Vijayawada'); // untouched on a non-structured update
  });

  test('a selected constituency is kept when provided', () => {
    const editor = staleEditor();
    applyReporterCoverageFields(editor, {
      assignedStates: ['Telangana'],
      assignedDistricts: ['Khammam'],
      assignedConstituencies: ['Madhira'],
    });
    expect(editor.assignedConstituencies).toEqual(['Madhira']);
    expect(editor.constituency).toBe('Madhira');
    expect(editor.assignedLocations).toEqual(['Telangana', 'Khammam', 'Madhira']);
  });
});
