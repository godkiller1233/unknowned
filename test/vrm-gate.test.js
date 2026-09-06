// VRM access policy: the Founder, Owner and official Administrator platform
// ranks may use .vrm avatars; everyone else is limited to .glb / 2D pictures /
// external-app cameras. These tests lock the gate helper's contract — the
// exact rank strings the server sends (users.rank: 'Founder' | 'Owner' |
// 'Administrator', default 'Member'), case-insensitivity for safety, and the
// .vrm filename detection used at import and live-use time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canUseVrmAvatar, isVrmAssetName, VRM_ALLOWED_RANKS } from '../src/avatar-store.js';

test('canUseVrmAvatar: staff-tier ranks allowed, members rejected', () => {
  assert.equal(canUseVrmAvatar('Founder'), true);
  assert.equal(canUseVrmAvatar('Owner'), true);
  assert.equal(canUseVrmAvatar('Administrator'), true);
  assert.equal(canUseVrmAvatar('Member'), false);
  // Other staff ranks (Mod..Manager) do NOT unlock VRM.
  assert.equal(canUseVrmAvatar('Mod'), false);
  assert.equal(canUseVrmAvatar('Manager'), false);
  assert.equal(canUseVrmAvatar('Head admin'), false);
  assert.equal(canUseVrmAvatar('admin'), false);
  assert.equal(canUseVrmAvatar('Dev'), false);
});

test('canUseVrmAvatar: case-insensitive and null-safe', () => {
  assert.equal(canUseVrmAvatar('founder'), true);
  assert.equal(canUseVrmAvatar('OWNER'), true);
  assert.equal(canUseVrmAvatar('  Administrator  '), true, 'server-side whitespace tolerated');
  assert.equal(canUseVrmAvatar(''), false);
  assert.equal(canUseVrmAvatar(null), false);
  assert.equal(canUseVrmAvatar(undefined), false);
});

test('VRM_ALLOWED_RANKS documents the policy', () => {
  assert.deepEqual([...VRM_ALLOWED_RANKS].sort(), ['administrator', 'founder', 'owner']);
});

test('isVrmAssetName: exact extension match only', () => {
  assert.equal(isVrmAssetName('death.vrm'), true);
  assert.equal(isVrmAssetName('female memegod.vrm'), true);
  assert.equal(isVrmAssetName('MODEL.VRM'), true);
  assert.equal(isVrmAssetName('avatar.glb'), false);
  assert.equal(isVrmAssetName('avatar.vrmb'), false);
  assert.equal(isVrmAssetName('avatar.gltf'), false);
  assert.equal(isVrmAssetName(''), false);
  assert.equal(isVrmAssetName(null), false);
});
