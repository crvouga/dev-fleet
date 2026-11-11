import Fuse from 'fuse.js';
import type { CommandSpec } from './contracts';

export function searchCommands(
  commands: CommandSpec[],
  term: string
): CommandSpec[] {
  const query = term.trim().toLowerCase();
  if (!query) return commands;
  const words = query.split(/\s+/);
  const exact = commands.filter((command) => {
    const text = [
      command.id,
      command.title,
      command.description,
      command.group,
      ...command.keywords,
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const fuzzy = new Fuse(commands, {
    keys: ['id', 'title', 'keywords', 'description'],
    threshold: 0.35,
    ignoreLocation: true,
  })
    .search(query)
    .map((result) => result.item);
  return [
    ...new Map(
      [...exact, ...fuzzy].map((command) => [command.id, command])
    ).values(),
  ];
}
