import { describe, expect, it } from 'vitest';
import { buildCreateOptions } from '../src/drivers/docker-driver.js';

describe('DockerDriver', () => {
  it('baut Ports und Env fuer docker run auf', () => {
    const options = buildCreateOptions({
      id: 'd-1',
      name: 'Docker',
      game: 'test',
      executable: 'nginx',
      args: [],
      workingDir: '/data',
      ports: [{ name: 'game', hostPort: 25580, containerPort: 80, protocol: 'tcp' }],
      env: { E: '1' },
    });

    expect(options).toContain('25580:80/tcp');
    expect(options).toContain('E=1');
    expect(options).toContain('--name');
    expect(options).toContain('d-1');
  });

  it('nutzt ohne containerPort den HostPort', () => {
    const options = buildCreateOptions({
      id: 'd-2',
      name: 'Docker',
      game: 'test',
      executable: 'nginx',
      args: [],
      workingDir: '/data',
      ports: [{ name: 'game', hostPort: 25581, protocol: 'udp' }],
    });

    expect(options).toContain('25581:25581/udp');
  });
});
