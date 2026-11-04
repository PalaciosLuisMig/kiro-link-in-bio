import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { MAX_LINKS } from '@link-in-bio/shared';

import type { StoredLink } from './entities.js';
import { LimitReached, ValidationError } from './errors.js';
import type { IdGenerator } from './ports.js';
import { createLink } from './manage-links.js';
import { InMemoryLinkRepository, SequentialIdGenerator } from './testing/fakes.js';

// Property 6: Límite de Enlaces e identificadores únicos.
//
// `createLink` cuenta los Enlaces existentes (activos e inactivos), rechaza con
// LimitReached cuando ya hay 10 sin crear nada (Requirement 6.9), y en otro
// caso crea un Enlace con un identificador nuevo DISTINTO de los existentes, en
// la posición `max(position) + 1` (o 0 si la lista está vacía) y con el título
// recortado (Requirement 6.1). Aquí verificamos esas invariantes sobre el doble
// en memoria de `LinkRepository`, que reproduce la condición
// `attribute_not_exists(pk)` del adaptador real.

// El código de dominio no puede tocar el `process` global de Node directamente
// (lo prohíbe el límite de ESLint de `backend/src/lib/domain/`), así que leemos
// la variable de entorno desde `globalThis`, igual que el resto de tests PBT.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

const VALID_URL = 'https://example.com/path';

/** Construye un StoredLink sembrable en el repositorio. */
function storedLink(index: number): StoredLink {
  return {
    id: `seed-${index}`,
    title: `seed title ${index}`,
    url: VALID_URL,
    position: index,
    active: index % 2 === 0,
    createdAt: 1_700_000_000_000 + index,
  };
}

/** Un IdGenerator que devuelve exactamente la secuencia dada, en orden. */
class ScriptedIdGenerator implements IdGenerator {
  private cursor = 0;
  constructor(private readonly ids: readonly string[]) {}
  next(): string {
    const id = this.ids[this.cursor];
    if (id === undefined) {
      throw new Error('ScriptedIdGenerator exhausted');
    }
    this.cursor += 1;
    return id;
  }
}

describe('createLink (Property 6: límite de Enlaces e identificadores únicos)', () => {
  // Validates: Requirements 6.1, 6.9
  //
  // Para 0..10 Enlaces existentes: con 10 la creación falla con LimitReached y
  // el repositorio NO cambia; con menos de 10 se crea exactamente un Enlace y el
  // total sube en 1.
  test('respeta el máximo de 10: con 10 rechaza sin cambios, con <10 crea uno', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: MAX_LINKS }), async (existing) => {
        const repo = new InMemoryLinkRepository();
        for (let i = 0; i < existing; i += 1) {
          repo.seed(storedLink(i));
        }
        const idGenerator = new SequentialIdGenerator('new');
        const before = await repo.list();

        if (existing >= MAX_LINKS) {
          await expect(
            createLink(repo, idGenerator, { title: 'nuevo', url: VALID_URL, now: 1 }),
          ).rejects.toBeInstanceOf(LimitReached);
          const after = await repo.list();
          // El repositorio no cambia: mismo conjunto de ids.
          expect(new Set(after.map((l) => l.id))).toEqual(new Set(before.map((l) => l.id)));
          expect(after).toHaveLength(before.length);
        } else {
          const created = await createLink(repo, idGenerator, {
            title: 'nuevo',
            url: VALID_URL,
            now: 1,
          });
          const after = await repo.list();
          expect(after).toHaveLength(before.length + 1);
          // El Enlace creado está en el repositorio.
          expect(after.map((l) => l.id)).toContain(created.id);
        }
      }),
      { numRuns },
    );
  });

  // Validates: Requirements 6.1
  //
  // El id del nuevo Enlace es DISTINTO del de cualquier Enlace existente.
  test('el id del nuevo Enlace es distinto de los existentes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: MAX_LINKS - 1 }), async (existing) => {
        const repo = new InMemoryLinkRepository();
        for (let i = 0; i < existing; i += 1) {
          repo.seed(storedLink(i));
        }
        const existingIds = new Set((await repo.list()).map((l) => l.id));
        const created = await createLink(repo, new SequentialIdGenerator('new'), {
          title: 'nuevo',
          url: VALID_URL,
          now: 1,
        });
        expect(existingIds.has(created.id)).toBe(false);
      }),
      { numRuns },
    );
  });

  // Validates: Requirements 6.1
  //
  // Cuando el IdGenerator devuelve primero un id que colisiona con uno existente
  // y luego uno nuevo, `createLink` debe regenerar y acabar con un id único.
  test('regenera el id ante una colisión y acaba con un id único', async () => {
    const repo = new InMemoryLinkRepository();
    const colliding = storedLink(0);
    repo.seed(colliding);

    // El generador ofrece primero el id ya existente (colisión) y luego uno libre.
    const idGenerator = new ScriptedIdGenerator([colliding.id, 'fresh-id']);
    const created = await createLink(repo, idGenerator, {
      title: 'nuevo',
      url: VALID_URL,
      now: 1,
    });

    expect(created.id).toBe('fresh-id');
    expect(created.id).not.toBe(colliding.id);
    const after = await repo.list();
    // Ningún id duplicado tras la creación.
    expect(new Set(after.map((l) => l.id)).size).toBe(after.length);
  });

  // Validates: Requirements 6.1
  //
  // La posición del nuevo Enlace es `max(position) + 1`, o 0 si la lista vacía.
  test('la posición es max(position)+1, o 0 si no hay Enlaces', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -5, max: 500 }), { minLength: 0, maxLength: MAX_LINKS - 1 }),
        async (positions) => {
          const repo = new InMemoryLinkRepository();
          positions.forEach((position, i) => {
            repo.seed({ ...storedLink(i), position });
          });
          const created = await createLink(repo, new SequentialIdGenerator('new'), {
            title: 'nuevo',
            url: VALID_URL,
            now: 1,
          });
          const expected = positions.length === 0 ? 0 : Math.max(...positions) + 1;
          expect(created.position).toBe(expected);
        },
      ),
      { numRuns },
    );
  });

  // Validates: Requirements 6.1
  //
  // El título se almacena recortado (trim).
  test('almacena el título recortado', async () => {
    const repo = new InMemoryLinkRepository();
    const created = await createLink(repo, new SequentialIdGenerator('new'), {
      title: '  Mi enlace  ',
      url: VALID_URL,
      now: 1,
    });
    expect(created.title).toBe('Mi enlace');
    const stored = await repo.get(created.id);
    expect(stored?.title).toBe('Mi enlace');
  });

  // Validates: Requirements 6.1
  //
  // Un título que no sobrevive al trim (solo espacios) se rechaza con
  // ValidationError nombrando el campo `title`, sin crear nada.
  test('un título que no sobrevive al trim se rechaza con ValidationError', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[ \t]{1,10}$/), async (whitespace) => {
        const repo = new InMemoryLinkRepository();
        await expect(
          createLink(repo, new SequentialIdGenerator('new'), {
            title: whitespace,
            url: VALID_URL,
            now: 1,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await repo.list()).toHaveLength(0);
      }),
      { numRuns },
    );
  });

  test('un título en blanco nombra el campo title en el ValidationError', async () => {
    const repo = new InMemoryLinkRepository();
    await expect(
      createLink(repo, new SequentialIdGenerator('new'), {
        title: '   ',
        url: VALID_URL,
        now: 1,
      }),
    ).rejects.toMatchObject({ fields: ['title'] });
  });

  // Validates: Requirements 6.1, 6.9
  //
  // Múltiples `createLink` en secuencia nunca superan los 10 Enlaces: las
  // primeras 10 tienen éxito y toda creación posterior falla con LimitReached.
  test('múltiples createLink en secuencia nunca superan 10', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (attempts) => {
        const repo = new InMemoryLinkRepository();
        const idGenerator = new SequentialIdGenerator('new');
        let created = 0;
        let rejected = 0;
        for (let i = 0; i < attempts; i += 1) {
          try {
            await createLink(repo, idGenerator, { title: `enlace ${i}`, url: VALID_URL, now: i });
            created += 1;
          } catch (error) {
            expect(error).toBeInstanceOf(LimitReached);
            rejected += 1;
          }
        }
        const after = await repo.list();
        expect(after.length).toBeLessThanOrEqual(MAX_LINKS);
        expect(created).toBe(Math.min(attempts, MAX_LINKS));
        expect(rejected).toBe(Math.max(0, attempts - MAX_LINKS));
      }),
      { numRuns },
    );
  });
});
