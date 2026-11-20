"""Rebrand app-owned bundled copy without changing compatibility identifiers."""

SEED_PREFIX = './seed/manifest_'
BIO_UA = './mcp-servers/bio-tools/lib/mcp_servers_common/ua.py'
COMPUTE_WRAPPER = './compute/wrapper.sh.tmpl'


def brand_product_resource(name: str, data: bytes) -> bytes:
    if name.startswith(SEED_PREFIX) and name.endswith('.json'):
        if data.count(b'Claude Science') < 4 or data.count(b'Anthropic infra and Git hosts for skill repos') != 1:
            raise RuntimeError('Seed product-copy boundary changed: ' + name)
        result = (data
                  .replace(b'Claude Science', b'Chimeric')
                  .replace(b'Anthropic infra and Git hosts for skill repos',
                           b'configured provider infrastructure and Git hosts for skill repositories'))
        if b'Claude Science' in result or b'Anthropic infra and Git hosts for skill repos' in result:
            raise RuntimeError('Seed product branding is incomplete: ' + name)
        return result
    if name == BIO_UA:
        if data.count(b'Claude-Science') < 2 or data.count(b'https://claude.com/product/claude-science') != 1 or data.count(b'outside Claude Science') < 2:
            raise RuntimeError('Bio-tools product-copy boundary changed')
        result = (data
                  .replace(b'Claude-Science', b'Chimeric')
                  .replace(b'https://claude.com/product/claude-science',
                           b'https://github.com/sammanalili/chimeric')
                  .replace(b'outside Claude Science', b'outside Chimeric'))
        if b'Claude-Science' in result or b'claude.com/product/claude-science' in result or b'outside Claude Science' in result:
            raise RuntimeError('Bio-tools product branding is incomplete')
        return result
    if name == COMPUTE_WRAPPER:
        marker = b'claude-science: WARN out/ is empty'
        if data.count(marker) != 1:
            raise RuntimeError('Compute wrapper product-copy boundary changed')
        return data.replace(marker, b'chimeric: WARN out/ is empty')
    return data
