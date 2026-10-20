const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { io } = require('socket.io-client');

async function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'online-server.cjs')], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', data => {
      output += data.toString();
      const match = output.match(/Online room server listening on port (\d+)/);
      if (match) resolve({ child, url: `http://localhost:${match[1]}` });
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before ready (${code}): ${output}`)));
  });
}

async function connect(url, name) {
  const socket = io(url, { reconnection: false, timeout: 3000 });
  await once(socket, 'connect');
  const guestId = randomUUID();
  assert.equal((await socket.timeout(3000).emitWithAck('guest:register', { guestId, name })).ok, true);
  return { socket, guestId };
}

test('room-code approval and guest-ID invitations', { timeout: 15000 }, async () => {
  const { child, url } = await startServer();
  const sockets = [];
  try {
    const host = await connect(url, 'Host');
    const guest = await connect(url, 'Guest');
    const invited = await connect(url, 'Invited');
    sockets.push(host.socket, guest.socket, invited.socket);

    const created = await host.socket.timeout(3000).emitWithAck('room:create', {
      mode: 'LOCAL_3', tokensPerPlayer: 2
    });
    assert.equal(created.ok, true);
    assert.equal(created.room.status, 'waiting');
    assert.equal(created.room.players.length, 1);
    const code = created.room.code;
    assert.equal((await host.socket.timeout(3000).emitWithAck('game:chat', {
      type: 'message', index: 0
    })).ok, false);

    const pendingEvent = once(host.socket, 'room:request');
    const pending = await guest.socket.timeout(3000).emitWithAck('room:join', { code });
    assert.equal(pending.pending, true);
    const [request] = await pendingEvent;
    assert.equal(request.guestId, guest.guestId);
    const deniedEvent = once(guest.socket, 'room:decision');
    assert.equal((await host.socket.timeout(3000).emitWithAck('room:respond', {
      requestId: request.id, accept: false
    })).ok, true);
    assert.equal((await deniedEvent)[0].accepted, false);

    const nextRequestEvent = once(host.socket, 'room:request');
    assert.equal((await guest.socket.timeout(3000).emitWithAck('room:join', { code })).pending, true);
    const [nextRequest] = await nextRequestEvent;
    const approvedEvent = once(guest.socket, 'room:decision');
    assert.equal((await invited.socket.timeout(3000).emitWithAck('room:respond', {
      requestId: nextRequest.id, accept: true
    })).ok, false);
    assert.equal((await host.socket.timeout(3000).emitWithAck('room:respond', {
      requestId: nextRequest.id, accept: true
    })).ok, true);
    const approved = (await approvedEvent)[0];
    assert.equal(approved.accepted, true);
    assert.equal(approved.room.players.length, 2);

    const inviteEvent = once(invited.socket, 'invite:new');
    assert.equal((await host.socket.timeout(3000).emitWithAck('room:invite', {
      guestId: invited.guestId
    })).ok, true);
    const [invitation] = await inviteEvent;
    assert.equal(invitation.code, code);
    assert.equal((await invited.socket.timeout(3000).emitWithAck('invite:respond', {
      inviteId: invitation.id, accept: false
    })).ok, true);

    const secondInviteEvent = once(invited.socket, 'invite:new');
    assert.equal((await host.socket.timeout(3000).emitWithAck('room:invite', {
      guestId: invited.guestId
    })).ok, true);
    const [secondInvite] = await secondInviteEvent;
    const joined = await invited.socket.timeout(3000).emitWithAck('invite:respond', {
      inviteId: secondInvite.id, accept: true
    });
    assert.equal(joined.ok, true);
    assert.equal(joined.room.players.length, 3);
    assert.equal((await host.socket.timeout(3000).emitWithAck('room:invite', {
      guestId: invited.guestId
    })).ok, false);
    const chatReceived = once(guest.socket, 'game:chat');
    assert.equal((await invited.socket.timeout(3000).emitWithAck('game:chat', {
      type: 'emoji', index: 2
    })).ok, true);
    assert.deepEqual((await chatReceived)[0], {
      playerId: joined.playerId, type: 'emoji', index: 2
    });
    assert.equal((await invited.socket.timeout(3000).emitWithAck('game:chat', {
      type: 'message', index: 0
    })).ok, false);
    assert.equal((await guest.socket.timeout(3000).emitWithAck('game:chat', {
      type: 'message', index: 100
    })).ok, false);
    const messageReceived = once(invited.socket, 'game:chat');
    assert.equal((await guest.socket.timeout(3000).emitWithAck('game:chat', {
      type: 'message', index: 0
    })).ok, true);
    assert.deepEqual((await messageReceived)[0], {
      playerId: approved.playerId, type: 'message', index: 0
    });

    const closingHost = await connect(url, 'Closing Host');
    const waitingGuest = await connect(url, 'Waiting Guest');
    const waitingInvitee = await connect(url, 'Waiting Invitee');
    sockets.push(closingHost.socket, waitingGuest.socket, waitingInvitee.socket);
    const closingRoom = await closingHost.socket.timeout(3000).emitWithAck('room:create', {
      mode: 'LOCAL_3'
    });
    const requestEvent = once(closingHost.socket, 'room:request');
    assert.equal((await waitingGuest.socket.timeout(3000).emitWithAck('room:join', {
      code: closingRoom.room.code
    })).pending, true);
    await requestEvent;
    const invitationEvent = once(waitingInvitee.socket, 'invite:new');
    assert.equal((await closingHost.socket.timeout(3000).emitWithAck('room:invite', {
      guestId: waitingInvitee.guestId
    })).ok, true);
    await invitationEvent;
    const cancelledRequest = once(waitingGuest.socket, 'room:decision');
    const cancelledInvitation = once(waitingInvitee.socket, 'invite:removed');
    closingHost.socket.emit('room:leave');
    assert.match((await cancelledRequest)[0].error, /Host left/);
    assert.ok((await cancelledInvitation)[0]);
    assert.equal((await waitingInvitee.socket.timeout(3000).emitWithAck('invite:respond', {
      inviteId: 'not-a-valid-invitation', accept: true
    })).ok, false);
  } finally {
    for (const socket of sockets) socket.disconnect();
    child.kill();
    await once(child, 'exit');
  }
});
