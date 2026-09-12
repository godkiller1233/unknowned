import test from 'node:test';
import assert from 'node:assert/strict';
import { isPgReachable, startDisposableServer } from './helpers/disposable-server.js';

test('external bot token can read/send, receives events, and revocation is immediate', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const stamp = Date.now().toString(36);
  const human = await srv.api('/api/register', null, { method:'POST', body:{ username:`bot_owner_${stamp}`, password:'owner-pass-1' } });
  assert.equal(human.status, 200, JSON.stringify(human));
  const boot = await srv.api('/api/bootstrap', human.token);
  const community = boot.communities.find(c => c.visibility === 'public');
  const channel = boot.channels.find(c => c.community_id === community.id && c.type === 'text');
  assert.ok(community && channel);

  const created = await srv.api(`/api/servers/${community.id}/bots/custom`, human.token, {
    method:'POST',
    body:{ name:'CI Bot', commands:[{ command:'ping', response:'pong' }] },
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const botId = created.bot.id;

  const tokenResponse = await srv.api(`/api/servers/${community.id}/bots/${botId}/tokens`, human.token, {
    method:'POST', body:{ name:'ci', scopes:['read_messages','send_messages'] },
  });
  assert.equal(tokenResponse.status, 201, JSON.stringify(tokenResponse));
  assert.match(tokenResponse.token, /^ubt_[A-Za-z0-9_-]{32,}$/);
  assert.equal(tokenResponse.scopes.length, 2);

  const botApi = (path, opts = {}) => fetch(srv.base + path, {
    method:opts.method || 'GET',
    headers:{ 'Content-Type':'application/json', 'X-Bot-Token':tokenResponse.token },
    body:opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async r => ({ status:r.status, ...(await r.json().catch(() => ({}))) }));
  const me = await botApi('/api/bot/me');
  assert.equal(me.status, 200, JSON.stringify(me));
  assert.equal(me.user.id, botId);
  const channels = await botApi(`/api/bot/servers/${community.id}/channels`);
  assert.equal(channels.status, 200, JSON.stringify(channels));

  const sent = await botApi(`/api/bot/servers/${community.id}/channels/${channel.id}/messages`, { method:'POST', body:{ body:'hello from external bot' } });
  assert.equal(sent.status, 201, JSON.stringify(sent));
  assert.equal(sent.message.sender_id, botId);
  const events = await botApi(`/api/bot/servers/${community.id}/events?after=0`);
  assert.equal(events.status, 200, JSON.stringify(events));
  assert.ok(events.events.some(e => e.event_type === 'message_sent'));

  const humanMessage = await srv.api('/api/messages', human.token, { method:'POST', body:{ channelId:channel.id, body:'hello bot' } });
  assert.equal(humanMessage.status, 200, JSON.stringify(humanMessage));
  const botEvents = await botApi(`/api/bot/servers/${community.id}/events?after=0`);
  assert.ok(botEvents.events.some(e => e.event_type === 'message_created'));

  const listed = await srv.api(`/api/servers/${community.id}/bots/${botId}/tokens`, human.token);
  assert.equal(listed.status, 200);
  assert.equal(listed.tokens[0].token, undefined);
  assert.equal(listed.tokens[0].prefix, tokenResponse.token.slice(0, 12));

  const revoked = await srv.api(`/api/servers/${community.id}/bots/${botId}/tokens/${tokenResponse.tokenId}`, human.token, { method:'DELETE' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked));
  const after = await botApi('/api/bot/me');
  assert.equal(after.status, 401, JSON.stringify(after));
});
