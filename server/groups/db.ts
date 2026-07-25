import { GetConnection, db } from 'db';
import type { UpsertResult } from 'mariadb';
import type { DbGroup, OxAccountRole } from 'types';

export function SelectGroups() {
  return db.query<DbGroup>(`
    SELECT 
      ox_groups.*,
      JSON_OBJECTAGG(ox_group_grades.grade, ox_group_grades.accountRole) AS accountRoles,
      JSON_ARRAYAGG(ox_group_grades.label ORDER BY ox_group_grades.grade) AS grades
    FROM 
        ox_groups
    JOIN 
        ox_group_grades
    ON
        ox_groups.name = ox_group_grades.group
    GROUP BY 
        ox_groups.name;
  `);
}

export async function InsertGroup({ name, label, type, colour, hasAccount, grades, accountRoles }: DbGroup) {
  await using conn = await GetConnection();
  await conn.beginTransaction();

  const insertedGroup = await conn.update(
    'INSERT IGNORE INTO `ox_groups` (`name`, `label`, `type`, `colour`, `hasAccount`) VALUES (?, ?, ?, ?, ?)',
    [name, label, type, colour, hasAccount],
  );

  if (!insertedGroup) return true;

  const insertedGrades = (await conn.batch(
    'INSERT INTO `ox_group_grades` (`group`, `grade`, `label`, `accountRole`) VALUES (?, ?, ?, ?)',
    grades.map((gradeLabel, index) => [name, index + 1, gradeLabel, accountRoles[index + 1]]),
  )) as UpsertResult[];

  await conn.commit();

  return insertedGrades.reduce((acc, curr) => acc + curr.affectedRows, 0) > 0;
}

export function RemoveGroup(groupName: string) {
  return db.update('DELETE FROM `ox_groups` WHERE name = ?', [groupName]);
}

export async function AddCharacterGroup(charId: number, name: string, grade: number) {
  return (
    (await db.update('INSERT INTO character_groups (charId, name, grade) VALUES (?, ?, ?)', [charId, name, grade])) ===
    1
  );
}

export async function UpdateCharacterGroup(charId: number, name: string, grade: number) {
  return (
    (await db.update('UPDATE character_groups SET grade = ? WHERE charId = ? AND name = ?', [grade, charId, name])) ===
    1
  );
}

export async function RemoveCharacterGroup(charId: number, name: string) {
  return (await db.update('DELETE FROM character_groups WHERE charId = ? AND name = ?', [charId, name])) === 1;
}

export function GetCharacterGroups(charId: number) {
  return db.execute<{ name: string; grade: number; isActive: boolean }>(
    'SELECT name, grade, isActive FROM character_groups WHERE charId = ?',
    [charId],
  );
}

export async function SetActiveGroup(charId: number, groupName?: string) {
  using conn = await GetConnection();
  const params: [number, string?] = [charId];

  conn.execute('UPDATE character_groups SET isActive = 0 WHERE charId = ? AND isActive = 1', params);

  if (groupName) {
    params.push(groupName);
    conn.execute('UPDATE character_groups SET isActive = 1 WHERE charId = ? AND name = ?', params);
  }
}

export function UpdateGroupData(name: string, label: string, colour: number | null, hasAccount: boolean) {
  return db.update('UPDATE `ox_groups` SET `label` = ?, `colour` = ?, `hasAccount` = ? WHERE `name` = ?', [
    label,
    colour,
    hasAccount,
    name,
  ]);
}

/** Number of members whose grade is above `maxGrade` — used to block orphaning a grade on removal. */
export function CountMembersAboveGrade(name: string, maxGrade: number) {
  return db.column<number>('SELECT COUNT(*) FROM `character_groups` WHERE `name` = ? AND `grade` > ?', [name, maxGrade]);
}

/**
 * Reconciles a group's grade rows to match `grades` (position = grade number):
 * upserts each grade in place and deletes any surplus trailing grades. The caller
 * must ensure no member holds a grade that would be deleted.
 */
export async function UpsertGroupGrades(name: string, grades: { label: string; accountRole?: OxAccountRole }[]) {
  await using conn = await GetConnection();
  await conn.beginTransaction();

  for (let index = 0; index < grades.length; index++) {
    await conn.execute(
      'INSERT INTO `ox_group_grades` (`group`, `grade`, `label`, `accountRole`) VALUES (?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE `label` = VALUES(`label`), `accountRole` = VALUES(`accountRole`)',
      [name, index + 1, grades[index].label, grades[index].accountRole ?? null],
    );
  }

  await conn.execute('DELETE FROM `ox_group_grades` WHERE `group` = ? AND `grade` > ?', [name, grades.length]);
  await conn.commit();
}
