const SKIPPED_TAGS = new Set([
	'head',
	'script',
	'style',
	'noscript',
	'template',
	'iframe',
	'object',
	'embed',
	'svg',
	'canvas'
]);

const BLOCK_TAGS = new Set([
	'address',
	'article',
	'aside',
	'div',
	'dl',
	'fieldset',
	'figcaption',
	'figure',
	'footer',
	'form',
	'header',
	'main',
	'nav',
	'section',
	'summary'
]);

function normalize(value: string) {
	return value
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function resolveUrl(href: string, baseUrl?: string) {
	if (!href || href.startsWith('#') || href.startsWith('javascript:')) return undefined;

	try {
		return baseUrl ? new URL(href, baseUrl).toString() : href;
	} catch {
		return href;
	}
}

function renderChildren(node: Node, baseUrl?: string) {
	return Array.from(node.childNodes)
		.map((child) => renderNode(child, baseUrl))
		.join('');
}

function renderInline(node: Node, baseUrl?: string) {
	return normalize(renderChildren(node, baseUrl)).replace(/\n+/g, ' ');
}

function renderListItem(item: Element, prefix: string, baseUrl?: string) {
	const content = Array.from(item.childNodes)
		.map((child) => {
			if (child instanceof Element && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
				return `\n${renderNode(child, baseUrl).trim()}`;
			}
			return renderNode(child, baseUrl);
		})
		.join('')
		.trim();

	return `${prefix}${content.replace(/\n/g, '\n  ')}\n`;
}

function renderTable(table: Element, baseUrl?: string) {
	const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
		Array.from(row.children).map((cell) => renderInline(cell, baseUrl).replace(/\|/g, '\\|'))
	);

	if (!rows.length) return '';

	const columns = Math.max(...rows.map((row) => row.length));
	const normalizedRows = rows.map((row) => [
		...row,
		...Array.from({ length: columns - row.length }, () => '')
	]);
	const separator = Array.from({ length: columns }, () => '---');
	const [header, ...body] = normalizedRows;
	const lines = [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`);
	return `\n\n${lines.join('\n')}\n\n`;
}

function renderNode(node: Node, baseUrl?: string): string {
	if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ');
	if (!(node instanceof Element)) return '';

	const tag = node.tagName.toLowerCase();
	if (SKIPPED_TAGS.has(tag)) return '';

	switch (tag) {
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return `\n\n${'#'.repeat(Number(tag[1]))} ${renderInline(node, baseUrl)}\n\n`;
		case 'br':
			return '\n';
		case 'hr':
			return '\n\n---\n\n';
		case 'strong':
		case 'b':
			return `**${renderInline(node, baseUrl)}**`;
		case 'em':
		case 'i':
			return `*${renderInline(node, baseUrl)}*`;
		case 'code':
			if (node.parentElement?.tagName.toLowerCase() === 'pre') return node.textContent ?? '';
			return `\`${(node.textContent ?? '').replace(/`/g, '\\`')}\``;
		case 'pre': {
			const code = node.querySelector('code');
			const language = code?.className.match(/language-([\w-]+)/)?.[1] ?? '';
			const text = (code ?? node).textContent?.replace(/\n$/, '') ?? '';
			return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
		}
		case 'a': {
			const href = resolveUrl(node.getAttribute('href') ?? '', baseUrl);
			const label = renderInline(node, baseUrl) || href || '';
			return href ? `[${label}](${href})` : label;
		}
		case 'img': {
			const src = resolveUrl(node.getAttribute('src') ?? '', baseUrl);
			const alt = node.getAttribute('alt')?.trim() ?? '';
			if (!src) return alt;
			return `![${alt}](${src})`;
		}
		case 'ul':
		case 'ol': {
			const items = Array.from(node.children).filter(
				(child) => child.tagName.toLowerCase() === 'li'
			);
			const ordered = tag === 'ol';
			const content = items
				.map((item, index) => renderListItem(item, ordered ? `${index + 1}. ` : '- ', baseUrl))
				.join('');
			return `\n\n${content}\n`;
		}
		case 'li':
			return renderListItem(node, '- ', baseUrl);
		case 'blockquote':
			return `\n\n${normalize(renderChildren(node, baseUrl))
				.split('\n')
				.map((line) => `> ${line}`)
				.join('\n')}\n\n`;
		case 'table':
			return renderTable(node, baseUrl);
		default:
			if (BLOCK_TAGS.has(tag)) return `\n\n${renderChildren(node, baseUrl)}\n\n`;
			return renderChildren(node, baseUrl);
	}
}

export function htmlToMarkdown(html: string, baseUrl?: string) {
	const document = new DOMParser().parseFromString(html, 'text/html');
	return normalize(renderChildren(document.body, baseUrl));
}

export function htmlToText(html: string) {
	const document = new DOMParser().parseFromString(html, 'text/html');
	for (const element of document.body.querySelectorAll(
		'script, style, noscript, template, iframe, object, embed'
	)) {
		element.remove();
	}
	return normalize(document.body.textContent ?? '');
}

export function truncateText(value: string, maxLength: number) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength).trimEnd()}\n\n[Content truncated]`;
}
