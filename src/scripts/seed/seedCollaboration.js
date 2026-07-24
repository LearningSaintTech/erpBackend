import { ChatRoom } from '../../modules/chat/chatRoom.model.js';
import { ChatMessage } from '../../modules/chat/chatMessage.model.js';
import { Delegation } from '../../modules/user/delegation.model.js';
import { isHeavy, isConditionsSeed, isFixtureSeed, seedLimit, safeSeed } from './seedHelpers.js';

const CHAT_MESSAGES = [
  'Good morning team — production targets for today?',
  'Batch BAT-001 cutting stage complete.',
  'Please review the new resort shirt submission.',
  'Fabric receipt expected tomorrow.',
  'QC passed on incoming GRN.',
  'Need approval on PR-F01-APP-004.',
  'Line 02 maintenance scheduled Friday.',
  'Sample fit approved for Demo Summer Shirt.',
];

async function seedChat(ctx) {
  const { factory, org, admin, roleUsers } = ctx;
  const chatService = await import('../../modules/chat/chat.service.js');
  const worker = roleUsers.worker || roleUsers.planner;
  const designer = roleUsers.designer;
  const qc = roleUsers.qc;

  const groupSpecs = isHeavy()
    ? [
      { name: 'Production Team', members: [worker, roleUsers.planner].filter(Boolean) },
      { name: 'Design Studio', members: [designer, roleUsers.designManager].filter(Boolean) },
    ]
    : isConditionsSeed()
      ? [{ name: 'Production Team', members: [worker, roleUsers.planner].filter(Boolean) }]
      : [{ name: 'Production Team', members: [worker].filter(Boolean) }];

  const rooms = [];
  for (const spec of groupSpecs) {
    if (!spec.members.length) continue;
    const existing = await ChatRoom.findOne({ factoryId: factory._id, name: spec.name, type: 'GROUP' });
    let room;
    if (!existing) {
      room = await chatService.createGroupRoom(factory._id, org._id, {
        name: spec.name,
        memberIds: spec.members.map((u) => u._id.toString()),
      }, admin._id);
      console.log(`Seeded chat group: ${spec.name}`);
    } else {
      room = existing;
    }
    const roomId = room._id || room.id;
    rooms.push(room);

    const msgCount = await ChatMessage.countDocuments({ roomId });
    const target = seedLimit({ heavy: 8, conditions: 4, light: 3 });
    if (msgCount < target) {
      const senders = [admin, ...spec.members].filter(Boolean);
      for (let i = msgCount; i < target; i += 1) {
        const sender = senders[i % senders.length];
        await safeSeed(`chat-msg-${roomId}-${i}`, () => chatService.sendMessage(
          roomId,
          sender._id,
          factory._id,
          ['*'],
          { body: CHAT_MESSAGES[i % CHAT_MESSAGES.length], organizationId: org._id },
        ));
      }
    }
  }

  const directPairs = isHeavy()
    ? [[admin, designer], [admin, qc], [roleUsers.designManager, designer]].filter(([a, b]) => a && b)
    : [[admin, worker]].filter(([a, b]) => a && b);

  for (const [a, b] of directPairs) {
    await safeSeed(`direct-${a.email}-${b.email}`, () => chatService.getOrCreateDirectRoom(
      factory._id,
      org._id,
      a._id,
      b._id,
      a._id,
    ));
  }

  const roomCount = await ChatRoom.countDocuments({ factoryId: factory._id, isDeleted: false });
  const messageCount = await ChatMessage.countDocuments({ factoryId: factory._id, isDeleted: false });
  console.log(`Chat: ${roomCount} rooms, ${messageCount} messages`);
}

async function seedDelegations(ctx) {
  if (!isFixtureSeed()) return;
  const delegationService = await import('../../modules/user/delegation.service.js');
  const { org, factory, admin, roleUsers } = ctx;

  // Do NOT delegate design.approve to the designer — authors must never approve their own queue.
  const pairs = [
    { delegator: roleUsers.productionManager || admin, delegate: roleUsers.planner, permissions: ['production.approve'] },
    { delegator: admin, delegate: roleUsers.purchase, permissions: ['purchase.approve'] },
  ].filter((p) => p.delegator && p.delegate);

  for (const spec of pairs) {
    const exists = await Delegation.findOne({
      factoryId: factory._id,
      delegatorId: spec.delegator._id,
      delegateId: spec.delegate._id,
      status: 'ACTIVE',
      isDeleted: false,
    });
    if (exists) continue;

    await safeSeed(`delegation-${spec.delegator.email}`, () => delegationService.createDelegation({
      organizationId: org._id,
      factoryId: factory._id,
      delegatorId: spec.delegator._id,
      delegateId: spec.delegate._id,
      permissions: spec.permissions,
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 86400000),
      reason: 'Seed demo delegation',
    }, admin._id, admin.email));
  }
  console.log('Seeded delegations');
}

export async function seedCollaboration(ctx) {
  await seedChat(ctx);
  await seedDelegations(ctx);
  return ctx;
}
