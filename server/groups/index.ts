import { addAce, addCommand, addPrincipal, removeAce, removePrincipal } from '@overextended/ox_lib/server';
import {
  CountMembersAboveGrade,
  InsertGroup,
  RemoveGroup,
  SelectGroups,
  UpdateGroupData,
  UpsertGroupGrades,
} from './db';
import { OxPlayer } from 'player/class';
import type { Dict, OxGroup, DbGroup, CreateGroupProperties, OxAccountRole, UpdateGroupProperties } from 'types';
import { GetGroupPermissions } from '../../common';
import { GetGroupAccount } from 'accounts';
import { CreateNewAccount } from 'accounts/db';

const groups: Dict<OxGroup> = {};
GlobalState.groups = [];

export function GetGroup(name: string) {
  return groups[name];
}

export function GetGroupsByType(type: string) {
  return Object.values(groups).reduce((acc, group) => {
    if (group.type === type) acc.push(group.name);
    return acc;
  }, [] as string[]);
}

export function GetGroupActivePlayers(groupName: string) {
  const group = groups[groupName];

  return group ? [...group.activePlayers] : [];
}

export function GetGroupActivePlayersByType(type: string) {
  return Object.values(groups).reduce((acc, group) => {
    if (group.type === type) {
      acc.push(...group.activePlayers);
    }
    return acc;
  }, [] as number[]);
}

export function SetGroupPermission(groupName: string, grade: number, permission: string, value: 'allow' | 'deny') {
  const permissions = GetGroupPermissions(groupName);

  if (!permissions[grade]) permissions[grade] = {};

  permissions[grade][permission] = value === 'allow' ? true : false;
  GlobalState[`group.${groupName}:permissions`] = permissions;
}

export function RemoveGroupPermission(groupName: string, grade: number, permission: string) {
  const permissions = GetGroupPermissions(groupName);

  if (!permissions[grade]) return;

  delete permissions[grade][permission];
  GlobalState[`group.${groupName}:permissions`] = permissions;
}

function SetupGroup(data: DbGroup) {
  const group: OxGroup = {
    ...data,
    principal: `group.${data.name}`,
    hasAccount: Boolean(data.hasAccount),
  };

  GlobalState[group.principal] = group;
  GlobalState[`${group.name}:count`] = 0;
  GlobalState[`${group.name}:activeCount`] = 0;

  group.activePlayers = new Set();

  groups[group.name] = group;
  group.grades = group.grades.reduce(
    (acc, value, index) => {
      acc[index + 1] = value;
      return acc;
    },
    {} as Record<number, string>,
  ) as any;

  let parent = group.principal;

  for (const i in group.grades) {
    const child = `${group.principal}:${i}`;

    if (!IsPrincipalAceAllowed(child, child)) {
      addAce(child, child, true);
      addPrincipal(child, parent);
    }

    parent = child;
  }

  if (group.hasAccount) {
    GetGroupAccount(group.name).then((account) => {
      if (!account) CreateNewAccount(group.name, group.label, true);
    });
  }

  DEV: console.info(`Instantiated OxGroup<${group.name}>`);

  return group;
}

// @todo more data validation and error handling
export async function CreateGroup(data: CreateGroupProperties) {
  if (groups[data.name]) throw new Error(`Cannot create OxGroup<${data.name}> (group already exists with that name)`);

  if (data.label.length > 50) {
    throw new Error(`Cannot create OxGroup<${data.name}> (label is too long)`);
  }

  const grades = data.grades.filter((grade) => grade.label).map((grade) => grade.label);

  const accountRoles = data.grades.reduce(
    (acc, grade, index) => {
      if (grade.accountRole) acc[index + 1] = grade.accountRole;
      return acc;
    },
    {} as Dict<OxAccountRole>,
  );

  if (grades.length === 0) {
    throw new Error(`Cannot create OxGroup<${data.name}> (missing at least one grade)`);
  }

  const group: DbGroup = {
    ...data,
    grades: grades,
    accountRoles: accountRoles,
    hasAccount: data.hasAccount ?? false,
    activePlayers: new Set(),
  };

  const response = await InsertGroup(group);

  if (response) {
    SetupGroup(group);
    GlobalState.groups = [...GlobalState.groups, data.name];
  }
}

export async function DeleteGroup(groupName: string) {
  const deleted = await RemoveGroup(groupName);
  const group = deleted && groups[groupName];

  if (!group) throw new Error(`Cannot delete OxGroup<${groupName}> (no group exists with that name)`);

  let parent = group.principal;

  removeAce(parent, parent, true);

  for (const i in group.grades) {
    const child = `${group.principal}:${i}`;

    removeAce(child, child, true);
    removePrincipal(child, parent);

    parent = child;
  }

  const players = OxPlayer.getAll({
    groups: groupName,
  });

  for (const id in players) {
    const player = players[id];

    player.setGroup(groupName, 0, true);
  }

  GlobalState[group.principal] = null;
  GlobalState[`${group.name}:count`] = null;
  GlobalState[`${group.name}:activeCount`] = null;
  GlobalState.groups = GlobalState.groups.filter((name: string) => name !== groupName);
  delete groups[group.name];
}

/**
 * Rebuilds runtime state for a single already-loaded group after its DB rows changed,
 * WITHOUT delete+recreate (members keep their membership). Fixes the gap in SetupGroup,
 * which only adds grade principals and never removes stale ones.
 */
function RefreshGroup(
  group: OxGroup,
  updated: { label: string; colour?: number; hasAccount: boolean; grades: string[]; accountRoles: Dict<OxAccountRole> },
) {
  // Tear down the current grade principal chain.
  let parent = group.principal;

  for (const i in group.grades) {
    const child = `${group.principal}:${i}`;

    removeAce(child, child, true);
    removePrincipal(child, parent);

    parent = child;
  }

  // Apply the new fields to the runtime object (grades held as a {gradeNum: label} map).
  group.label = updated.label;
  group.colour = updated.colour;
  group.hasAccount = Boolean(updated.hasAccount);
  group.accountRoles = updated.accountRoles;
  group.grades = updated.grades.reduce(
    (acc, value, index) => {
      acc[index + 1] = value;
      return acc;
    },
    {} as Record<number, string>,
  ) as any;

  // Republish metadata for consumers (grades as an ordered array, like SelectGroups).
  GlobalState[group.principal] = {
    name: group.name,
    label: updated.label,
    type: group.type,
    colour: updated.colour,
    hasAccount: Boolean(updated.hasAccount),
    principal: group.principal,
    grades: updated.grades,
    accountRoles: updated.accountRoles,
  };

  // Rebuild the grade principal chain from the new grades.
  //
  // Deliberately unconditional, unlike SetupGroup. addAce/addPrincipal run
  // through ox_lib, which issues them as console commands — those take effect
  // on the next tick, not immediately. The teardown above is therefore still
  // invisible to IsPrincipalAceAllowed at this point: the guard would see the
  // old chain, believe it intact and skip re-linking. Once the queued removals
  // land, the chain is gone for good and every member of the group silently
  // loses each ACE inherited from `group.<name>`.
  //
  // Both calls are safe to repeat, so there is nothing to guard against.
  parent = group.principal;

  for (const i in group.grades) {
    const child = `${group.principal}:${i}`;

    addAce(child, child, true);
    addPrincipal(child, parent);

    parent = child;
  }

  if (group.hasAccount) {
    GetGroupAccount(group.name).then((account) => {
      if (!account) CreateNewAccount(group.name, group.label, true);
    });
  }
}

/**
 * Edits an existing group in place: core fields (label/colour/hasAccount) and/or grades.
 * Grades reconcile by position (index+1 = grade number): labels/roles update in place,
 * new grades append at the end. Removing a grade a member still holds is rejected, so no
 * member is ever orphaned. Members are never kicked (no delete+recreate).
 */
export async function UpdateGroup(name: string, data: UpdateGroupProperties) {
  const group = groups[name];

  if (!group) throw new Error(`Cannot update OxGroup<${name}> (no group exists with that name)`);

  const label = data.label ?? group.label;

  if (label.length > 50) throw new Error(`Cannot update OxGroup<${name}> (label is too long)`);

  const colour = data.colour ?? group.colour;
  const hasAccount = data.hasAccount ?? group.hasAccount;

  // Resolve the target grade set: the new one if provided, else the current runtime grades.
  let gradeList: { label: string; accountRole?: OxAccountRole }[];

  if (data.grades) {
    gradeList = data.grades.filter((grade) => grade.label);

    if (gradeList.length === 0) throw new Error(`Cannot update OxGroup<${name}> (missing at least one grade)`);

    // Never orphan a member: reject shrinking below a grade someone still holds.
    const orphans = (await CountMembersAboveGrade(name, gradeList.length)) ?? 0;

    if (orphans > 0)
      throw new Error(
        `Cannot update OxGroup<${name}> (${orphans} member(s) hold a grade above ${gradeList.length}; reassign them first)`,
      );

    await UpsertGroupGrades(name, gradeList);
  } else {
    gradeList = Object.keys(group.grades)
      .map(Number)
      .sort((a, b) => a - b)
      .map((gradeNumber) => ({
        label: (group.grades as any)[gradeNumber] as string,
        accountRole: group.accountRoles[gradeNumber],
      }));
  }

  await UpdateGroupData(name, label, colour ?? null, hasAccount);

  const grades = gradeList.map((grade) => grade.label);
  const accountRoles = gradeList.reduce((acc, grade, index) => {
    if (grade.accountRole) acc[index + 1] = grade.accountRole;
    return acc;
  }, {} as Dict<OxAccountRole>);

  RefreshGroup(group, { label, colour, hasAccount, grades, accountRoles });
}

async function LoadGroups() {
  const dbGroups = await SelectGroups();
  GlobalState.groups = dbGroups.map((group) => SetupGroup(group).name);
}

setImmediate(LoadGroups);

addCommand('reloadgroups', LoadGroups, {
  help: 'Reload groups from the database.',
  restricted: 'group.admin',
});

addCommand<{ target: string; group: string; grade?: number }>(
  'setgroup',
  async (playerId, args, raw) => {
    const player = OxPlayer.get(args.target);

    player?.setGroup(args.group, args.grade || 0);
  },
  {
    help: `Update a player's grade for a group.`,
    restricted: 'group.admin',
    params: [
      { name: 'target', type: 'playerId' },
      { name: 'group', type: 'string' },
      {
        name: 'grade',
        type: 'number',
        help: 'The new grade to set. Set to 0 or omit to remove the group.',
        optional: true,
      },
    ],
  },
);

exports('GetGroupsByType', GetGroupsByType);
exports('SetGroupPermission', SetGroupPermission);
exports('RemoveGroupPermission', RemoveGroupPermission);
exports('CreateGroup', CreateGroup);
exports('UpdateGroup', UpdateGroup);
exports('DeleteGroup', DeleteGroup);
exports('GetGroupActivePlayers', GetGroupActivePlayers);
exports('GetGroupActivePlayersByType', GetGroupActivePlayersByType);
