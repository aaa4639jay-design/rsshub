businessweekly/channel.ts

import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import { parseDate } from '@/utils/parse-date';

const rootUrl = 'https://www.businessweekly.com.tw';

const channelMap: Record<string, { slug: string; title: string }> = {
    '0000000319': { slug: 'business', title: '財經' },
    '0000000320': { slug: 'insight', title: '產業動態' },
    '0000000321': { slug: 'trends', title: '商業趨勢' },
    '0000000322': { slug: 'people', title: '焦點人物' },
    '0000000323': { slug: 'money', title: '投資理財' },
    '0000000324': { slug: 'realestate', title: '地產風雲' },
};

const buildChannelUrl = (id: string) => {
    const mapped = channelMap[id];
    return mapped ? new URL(`/channel/${mapped.slug}/${id}`, rootUrl).href : new URL(`/channel/business/${id}`, rootUrl).href;
};

const sanitizeTitle = (value: string) => value.replace(/\s+/g, ' ').trim();

const decodeJsonString = (value: string) => {
    try {
        return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
    } catch {
        return value
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"');
    }
};

const extractArticleBodyFromJsonLd = (html: string) => {
    const matched = html.match(/"articleBody":"([\s\S]*?)"[,}]/);
    if (!matched) {
        return undefined;
    }

    const decoded = decodeJsonString(matched[1]);
    return decoded ? `<p>${decoded.replace(/\n+/g, '</p><p>')}</p>` : undefined;
};

const extractJsonLdAuthor = (html: string) => {
    const matched = html.match(/"author":\{"@type":"Person","name":"([^"]+)"\}/);
    return matched ? decodeJsonString(matched[1]) : undefined;
};

const appendItems = (
    html: string,
    list: Array<{ title: string; link: string; pubDate?: string; author?: string; category?: string[] }>,
    seen: Set<string>,
    channelTitle: string
) => {
    const fragment = load(html);
    fragment('figure.Article-figure').each((_, element) => {
        const anchor = fragment(element).find('div.Article-content a').first();
        const href = anchor.attr('href');
        const title = sanitizeTitle(anchor.text());
        if (!href || !title) {
            return;
        }

        const link = new URL(href, rootUrl).href;
        if (seen.has(link)) {
            return;
        }
        seen.add(link);

        const source = sanitizeTitle(fragment(element).find('.Article-source').first().text());
        const author = sanitizeTitle(fragment(element).find('.Article-author').first().text());
        const dateText = sanitizeTitle(fragment(element).find('.Article-date').first().text());

        list.push({
            title,
            link,
            pubDate: dateText ? parseDate(dateText.replace(/\./g, '-'), 'Asia/Taipei') : undefined,
            author: author || source || undefined,
            category: [channelTitle].filter(Boolean),
        });
    });
};

const handler = async (ctx) => {
    const id = ctx.req.param('id') ?? '0000000319';
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit'), 10) : 40;
    const pageSize = 20;

    const channelUrl = buildChannelUrl(id);
    const response = await got({
        method: 'get',
        url: channelUrl,
        headers: {
            'user-agent': 'Mozilla/5.0',
        },
    });

    const $ = load(response.data);
    const channelTitle = sanitizeTitle($('h2.Article-list-title').first().text()) || channelMap[id]?.title || sanitizeTitle($('title').text()) || `商周頻道 ${id}`;
    const pageChannelId = response.data.match(/var\s+ChannelID\s*=\s*"(\d+)"/)?.[1] ?? id;

    const list: Array<{ title: string; link: string; pubDate?: string; author?: string; category?: string[] }> = [];
    const seen = new Set<string>();

    appendItems(response.data, list, seen, channelTitle);

    for (let start = 1; start <= limit && list.length < limit; start += pageSize) {
        const end = start + pageSize - 1;
        const blockResponse = await got({
            method: 'post',
            url: new URL('/ChannelAction/LoadBlock/', rootUrl).href,
            headers: {
                'user-agent': 'Mozilla/5.0',
                referer: channelUrl,
                'x-requested-with': 'XMLHttpRequest',
            },
            form: {
                Start: String(start),
                End: String(end),
                ID: pageChannelId,
            },
        });

        if (!blockResponse.data?.trim()) {
            break;
        }

        const before = list.length;
        appendItems(blockResponse.data, list, seen, channelTitle);
        if (list.length === before) {
            break;
        }
    }

    const items = await Promise.all(
        list.slice(0, limit).map((item) =>
            cache.tryGet(item.link, async () => {
                const detailResponse = await got({
                    method: 'get',
                    url: item.link,
                    headers: {
                        'user-agent': 'Mozilla/5.0',
                    },
                });

                const detail = load(detailResponse.data);
                detail('script, style, iframe, .ad, .advertisement, .Article-paywall, .paywall').remove();

                const articleBody =
                    detail('[itemprop="articleBody"]').first().html() ??
                    detail('.Article-content-wrap').first().html() ??
                    detail('.content-body').first().html() ??
                    detail('.article-content').first().html() ??
                    extractArticleBodyFromJsonLd(detailResponse.data);

                const metaPublished = detail('meta[property="article:published_time"]').attr('content');
                const metaAuthor = detail('meta[name="author"]').attr('content');
                const jsonLdAuthor = extractJsonLdAuthor(detailResponse.data);
                const ogTitle = detail('meta[property="og:title"]').attr('content');

                return {
                    ...item,
                    title: item.title || ogTitle || sanitizeTitle(detail('title').text()),
                    pubDate: metaPublished ? parseDate(metaPublished) : item.pubDate,
                    author: metaAuthor || jsonLdAuthor || item.author,
                    description: articleBody,
                };
            })
        )
    );

    return {
        title: `商周｜${channelTitle}`,
        link: channelUrl,
        item: items,
    };
};

export const route: Route = {
    path: '/channel/:id',
    categories: ['finance', 'new-media'],
    example: '/businessweekly/channel/0000000319',
    parameters: {
        id: '商周頻道 ID，可在 URL 或頁面內的 ChannelID 找到，例如 0000000319',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['businessweekly.com.tw/channel/business/:id'],
            target: '/channel/:id',
        },
        {
            source: ['businessweekly.com.tw/channel/insight/:id'],
            target: '/channel/:id',
        },
        {
            source: ['businessweekly.com.tw/channel/trends/:id'],
            target: '/channel/:id',
        },
        {
            source: ['businessweekly.com.tw/channel/people/:id'],
            target: '/channel/:id',
        },
        {
            source: ['businessweekly.com.tw/channel/money/:id'],
            target: '/channel/:id',
        },
        {
            source: ['businessweekly.com.tw/channel/realestate/:id'],
            target: '/channel/:id',
        },
    ],
    name: '頻道',
    maintainers: ['investment-advisor-bot'],
    handler,
};