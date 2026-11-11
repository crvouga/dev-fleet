import { record, reportChecks, text } from './ui-data';
import type { CheckRow, Choice, Session } from './ui-types';

export async function inspectChecks(
  session: Session,
  data: unknown
): Promise<void> {
  const checks = reportChecks(data);
  let node = '*';
  let status = '*';
  while (true) {
    const visible = checks.filter(
      (check) =>
        (node === '*' || check.node === node) &&
        (status === '*' || check.status === status)
    );
    const choice = await session.prompts.search(
      `Report · ${visible.length}/${checks.length} checks · node ${node} · status ${status}`,
      (term) => checkChoices(visible, term)
    );
    if (choice === 'back') return;
    if (choice === 'node') node = await nodeFilter(session, checks);
    else if (choice === 'status') status = await statusFilter(session);
    else {
      const check = visible[Number(choice)];
      if (check) showCheck(session, check);
    }
  }
}

function checkChoices(checks: CheckRow[], term: string): Choice[] {
  const choices = checks.flatMap((check, index) => {
    const name = `${check.status.toUpperCase()} · ${check.node} · ${check.id}`;
    return `${name} ${check.summary}`.toLowerCase().includes(term.toLowerCase())
      ? [{ name, value: String(index), description: check.summary }]
      : [];
  });
  return [
    ...(choices.length
      ? choices
      : [
          {
            name: 'No matching checks — change search or filters',
            value: 'none',
          },
        ]),
    { name: 'Filter by node', value: 'node' },
    { name: 'Filter by status', value: 'status' },
    { name: 'Back to result', value: 'back' },
  ];
}

function nodeFilter(session: Session, checks: CheckRow[]): Promise<string> {
  return session.prompts.select('Node filter', [
    { name: 'All nodes', value: '*' },
    ...[...new Set(checks.map((check) => check.node))].map((node) => ({
      name: node,
      value: node,
    })),
  ]);
}

function statusFilter(session: Session): Promise<string> {
  return session.prompts.select('Status filter', [
    { name: 'All statuses (including warnings and skips)', value: '*' },
    ...['fail', 'warn', 'skip', 'pass'].map((status) => ({
      name: status.toUpperCase(),
      value: status,
    })),
  ]);
}

function showCheck(session: Session, check: CheckRow): void {
  session.display.panel(
    `${check.status.toUpperCase()} · ${check.node} · ${check.id}`,
    check.summary
  );
  session.display.write(
    `Remedy: ${check.remedy || 'No automated remedy. Review this check manually.'}`
  );
  if (check.command)
    session.display.write(
      `Suggested operator command (not executed):\n${check.command}`
    );
  session.display.write(
    'Remedies are guidance only. Credentials, SSH and host-key configuration stay operator-owned.'
  );
}

export async function inspectDetails(
  session: Session,
  data: unknown
): Promise<void> {
  const sections = detailSections(data);
  if (!sections.length) {
    session.display.write(
      'No additional safe display fields. Use the reproducible command for the structured document.'
    );
    return;
  }
  let next = true;
  while (next) {
    const selection = await session.prompts.select('Details', [
      ...sections.map((section, index) => ({
        name: section.title,
        value: String(index),
      })),
      { name: 'Back to result', value: 'back' },
    ]);
    const section = sections[Number(selection)];
    if (selection === 'back') next = false;
    else if (section) session.display.panel(section.title, section.body);
  }
}

function detailSections(data: unknown): { title: string; body: string }[] {
  if (!record(data)) return [];
  const sections = [
    'help',
    'guide',
    'next',
    'authorize',
    'path',
    'sshTemplate',
    'workspaceCommand',
    'verifyCommand',
    'invocation',
    'discovery',
  ].flatMap((key) =>
    typeof data[key] === 'string' ? [{ title: key, body: text(data[key]) }] : []
  );
  for (const key of ['steps', 'targets', 'safety', 'examples']) {
    if (Array.isArray(data[key]))
      sections.push(
        ...data[key].flatMap((value: unknown, index: number) =>
          typeof value === 'string'
            ? [{ title: `${key} · ${index + 1}`, body: text(value) }]
            : []
        )
      );
  }
  if (Array.isArray(data['nodes']))
    sections.push(...nodeSections(data['nodes']));
  if (Array.isArray(data['commands']))
    sections.push(...commandSections(data['commands']));
  for (const key of ['configuration', 'output', 'coverage']) {
    if (record(data[key]))
      sections.push({ title: key, body: safeFields(data[key]) });
  }
  if (typeof data['$schema'] === 'string')
    sections.push({
      title: 'JSON schema',
      body: JSON.stringify(data, null, 2),
    });
  return sections;
}

function commandSections(
  commands: unknown[]
): { title: string; body: string }[] {
  return commands.flatMap((command) => {
    if (!record(command)) return [];
    return [
      {
        title: text(command['id'], 'Command'),
        body: [
          text(command['title']),
          text(command['description']),
          ...(Array.isArray(command['examples'])
            ? command['examples'].map((value: unknown) => text(value))
            : []),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
  });
}

function safeFields(value: Record<string, unknown>): string {
  return Object.entries(value)
    .flatMap(([key, field]) =>
      typeof field === 'string' ? [`${key}: ${text(field)}`] : []
    )
    .join('\n');
}

function nodeSections(nodes: unknown[]): { title: string; body: string }[] {
  return nodes.flatMap((node) => {
    if (!record(node)) return [];
    const id = text(node['id'], text(node['node'], 'Node'));
    const body = ['id', 'ssh', 'workspace', 'runtime'].flatMap((key) =>
      typeof node[key] === 'string' ? [`${key}: ${text(node[key])}`] : []
    );
    if (Array.isArray(node['required']))
      body.push(
        `required: ${node['required'].map((value: unknown) => text(value)).join(', ') || 'none'}`
      );
    return [
      ...(body.length ? [{ title: id, body: body.join('\n') }] : []),
      ...detailSections({
        steps: node['steps'],
        sshTemplate: node['sshTemplate'],
        verifyCommand: node['verifyCommand'],
      }).map((section) => ({
        title: `${id} · ${section.title}`,
        body: section.body,
      })),
    ];
  });
}
