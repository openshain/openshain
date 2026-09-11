import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlFile } from "../config/yaml.ts";
import { OpenshainError } from "../errors.ts";
import { matchGlob, reaches } from "./glob.ts";

/**
 * The people of the company, one file each. A file is where a person starts and stops being one:
 * git keeps the day they joined and the day they left, and taking somebody out is one line.
 */

export const PRINCIPALS_DIR_NAME = "principals";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]*$/);

export const PrincipalSchema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(200),
  /** What this person handles, in the company's own words. Not a qualification. */
  roles: z.array(identifier).max(20).default([]),
  status: z.enum(["active", "inactive"]).default("active"),
  /**
   * The paths their work covers. Absent: the whole company folder, as before. An empty list is
   * refused: it reads as a mistake, and somebody who is to see nothing is inactive instead.
   */
  reads: z.array(z.string().min(1).max(1000)).min(1).max(100).optional(),
  /** Whose records they read. Absent: own when reads is written, all otherwise. */
  records: z.enum(["own", "all"]).optional(),
});

export type Principal = z.infer<typeof PrincipalSchema>;

/** A file name a person would have written: `<id>.yaml`, and nothing else. */
const NAMED_FOR_A_PERSON = /^[a-z][a-z0-9_-]*\.yaml$/;

/**
 * Everyone under principals/, by id. A name that is not `<id>.yaml` is passed over: a folder on a
 * sync service grows files like `bob (conflicted copy).yaml`, and one of those must not stop the
 * company from deciding anything. What is read is read strictly: a file that disagrees with its
 * own name, or YAML that does not parse, and nothing runs. The name is what makes a person one
 * person, so two files cannot claim the same one.
 */
export async function readPrincipals(dir: string): Promise<Map<string, Principal>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return new Map();
  }
  const people = new Map<string, Principal>();
  for (const name of names.filter((n) => NAMED_FOR_A_PERSON.test(n)).sort()) {
    const where = `${PRINCIPALS_DIR_NAME}/${name}`;
    const { data } = parseYamlFile(await readFile(join(dir, name), "utf8"), PrincipalSchema, where);
    const expected = name.replace(/\.yaml$/, "");
    if (data.id !== expected) {
      throw new OpenshainError(
        "config",
        `${where} is the file of ${expected} but says id: ${data.id}. A person is one file, named after them`,
      );
    }
    people.set(data.id, data);
  }
  return people;
}

/** Whether this person may act today. Somebody who is not written at all cannot. */
export function isActive(people: Map<string, Principal>, id: string): boolean {
  if (people.size === 0) return true;
  return people.get(id)?.status === "active";
}

/**
 * Whether this path is inside the person's range. Somebody with no range written reads the whole
 * company folder, as everyone did before there was more than one person.
 */
export function mayRead(person: Principal | undefined, path: string): boolean {
  const reads = person?.reads;
  if (reads === undefined) return true;
  return reads.some((pattern) => matchGlob(pattern, path));
}

/** Whether anything inside this directory could be in the range: false means do not go in. */
export function mayReachInto(person: Principal | undefined, dir: string): boolean {
  const reads = person?.reads;
  if (reads === undefined) return true;
  return reads.some((pattern) => reaches(pattern, dir));
}
