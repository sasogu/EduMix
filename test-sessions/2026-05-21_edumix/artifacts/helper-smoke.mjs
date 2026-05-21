import assert from 'node:assert/strict';
import { findDuplicateTracks } from '../../../modules/duplicate-detector.js';
import { trackExistsInPlaylist, countTrackReferencesInManualPlaylists, countDropboxPathReferences } from '../../../modules/track-utils.js';

const playlists = [
  { id: 'p1', name: 'Rock', tracks: [
    { id: 't1', name: 'Song A', fileName: 'Song A.mp3', duration: 120, dropboxPath: '/tracks/a.mp3' },
    { id: 't2', name: 'Song B', fileName: 'Song B.mp3', duration: 200, dropboxPath: '/tracks/b.mp3' },
  ]},
  { id: 'p2', name: 'Mix', tracks: [
    { id: 't3', name: 'Different title', fileName: 'song a.mp3', duration: 121, dropboxPath: '/tracks/a-copy.mp3' },
    { id: 't4', name: 'Song C', fileName: 'c.mp3', duration: 180, dropboxPath: '/tracks/c.mp3' },
    { id: 't5', name: 'Song C', fileName: 'c-live.mp3', duration: 181, dropboxPath: '/tracks/c-live.mp3' },
  ]},
  { id: 'fav', name: 'Favoritas', isAuto: true, tracks: [
    { id: 't6', name: 'Song A', fileName: 'Song A.mp3', duration: 120, dropboxPath: '/tracks/a.mp3' },
  ]},
];

assert.equal(trackExistsInPlaylist(playlists[0], 't1'), true);
assert.equal(trackExistsInPlaylist(playlists[0], 'missing'), false);
assert.equal(countTrackReferencesInManualPlaylists(playlists, 't1'), 1, 'auto playlist refs must not count');
assert.equal(countTrackReferencesInManualPlaylists(playlists, 't1', 'p1'), 0, 'excluded playlist must not count');
assert.equal(countDropboxPathReferences(playlists, '/tracks/a.mp3'), 1, 'auto playlist dropbox refs must not count');

const groups = findDuplicateTracks(playlists);
assert.equal(groups.some(g => g.criterion === 'fileName' && g.items.map(i => i.track.id).sort().join(',') === 't1,t3'), true, 'same filename duplicates detected case-insensitively');
assert.equal(groups.some(g => g.criterion === 'nameAndDuration' && g.items.map(i => i.track.id).sort().join(',') === 't4,t5'), true, 'same name and ±2s duration duplicates detected');
assert.equal(groups.some(g => g.items.some(i => i.track.id === 't6')), false, 'auto playlist ignored');

console.log('helper-smoke: PASS');
