/**
 * Automated Replies activity: what shoppers asked, and what the bot did about it.
 *
 * The feed deliberately mixes answers with SKIPS. A merchant asking "why did
 * nobody hear back from us" gets no help from a list of successes, and the skip
 * reason is the whole answer: muted, rate limited, a voice note, feature off.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useNavigation } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Select,
  IndexTable,
  Banner,
  Box,
  Link,
  TextField,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { aiReplyStats, recentAiReplyActivity, skipLabel } from "../utils/ai-reply-stats.server";
import { SplitTrend } from "../components/SplitTrend";
import { Stat, RankedList, Split, ago, nfmt } from "../components/Stats";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The presets, each resolved to an explicit IST day range.
 *
 * Deliberately not a map of day COUNTS: "yesterday" is the one preset that does
 * not end today, and expressing it as a count forces a special case at every
 * call site. Returning both ends keeps the loader a single lookup.
 */
const WINDOWS: Record<string, (today: string) => { from: string; to: string }> = {
  today: (t) => ({ from: t, to: t }),
  yesterday: (t) => ({ from: addDays(t, -1), to: addDays(t, -1) }),
  "7d": (t) => ({ from: addDays(t, -6), to: t }),
  "30d": (t) => ({ from: addDays(t, -29), to: t }),
  "90d": (t) => ({ from: addDays(t, -89), to: t }),
};

const WINDOW_OPTIONS = [
  { label: "Today", value: "today" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "Custom range", value: "custom" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const requested = params.get("window") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";

  // A custom range wins when both ends are well-formed; anything else falls back
  // to a preset. Both are validated: these values become query bounds.
  const custom = ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to;
  const windowKey = custom ? "custom" : WINDOWS[requested] ? requested : "7d";

  const today = istToday();
  const preset = custom ? null : WINDOWS[windowKey](today);
  const fromDay = preset ? preset.from : from;
  // Never run a custom range past today: future days would plot as a flat zero
  // tail and read as the bot having gone quiet.
  const toDay = preset ? preset.to : to > today ? today : to;

  const [stats, activity, settings] = await Promise.all([
    aiReplyStats(session.shop, fromDay, toDay),
    recentAiReplyActivity(session.shop, 50),
    prisma.aiReplySettings.findUnique({ where: { shop: session.shop } }),
  ]);

  return json({
    windowKey,
    fromDay,
    toDay,
    stats,
    // Without an LLM key nothing can be answered at all, so a queue that is
    // filling up needs to say why rather than just showing zeros.
    aiReady: Boolean(settings?.isEnabled && settings?.apiKey),
    waReady: Boolean(settings?.waReplyEnabled && settings?.waApiKey),
    topSkips: stats.topSkips.map((s) => ({ label: skipLabel(s.reason), count: s.count })),
    activity: activity.map((a) => ({
      id: a.id,
      when: a.when.toISOString(),
      channel: a.channel,
      who: a.who,
      // Long messages would push every other column off screen; the full text is
      // on hover, where it costs nothing.
      message: a.message.length > 90 ? `${a.message.slice(0, 90)}...` : a.message,
      fullMessage: a.message,
      status: a.status,
      // For a skip this holds the reason, not an error. Translated here so the
      // table never renders a raw enum like "rate-limited".
      note: a.status === "skipped" ? skipLabel(a.error) : a.error,
    })),
  });
};

export default function AiRepliesActivityPage() {
  const d = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const nav = useNavigation();
  const s = d.stats;

  // The loader re-runs on every range change, so on a slow connection the page
  // sat there looking broken. This drives a spinner and dims the stale figures.
  const loading = nav.state === "loading";

  const [customFrom, setCustomFrom] = useState(d.fromDay);
  const [customTo, setCustomTo] = useState(d.toDay);
  const [showCustom, setShowCustom] = useState(d.windowKey === "custom");

  const applyCustom = () => {
    if (customFrom && customTo && customFrom <= customTo) {
      setSearchParams({ from: customFrom, to: customTo });
    }
  };

  const dim = { opacity: loading ? 0.5 : 1, transition: "opacity 150ms" };

  return (
    <Page fullWidth>
      <TitleBar title="Automated Replies" />
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Select
              label="Period"
              labelHidden
              disabled={loading}
              options={WINDOW_OPTIONS}
              value={d.windowKey}
              onChange={(v) => {
                if (v === "custom") {
                  setShowCustom(true); // reveal the fields; don't reload yet
                } else {
                  setShowCustom(false);
                  setSearchParams({ window: v });
                }
              }}
            />
            {showCustom && (
              <>
                <TextField
                  label="From"
                  labelHidden
                  type="date"
                  value={customFrom}
                  onChange={setCustomFrom}
                  autoComplete="off"
                  max={d.toDay}
                />
                <TextField
                  label="To"
                  labelHidden
                  type="date"
                  value={customTo}
                  onChange={setCustomTo}
                  autoComplete="off"
                  min={customFrom}
                />
                <Button
                  onClick={applyCustom}
                  loading={loading}
                  disabled={!customFrom || !customTo || customFrom > customTo}
                >
                  Apply
                </Button>
              </>
            )}
            {/* Something must acknowledge the click, or a slow load reads as a
                dead control and gets clicked again. */}
            {loading && <Spinner accessibilityLabel="Loading" size="small" />}
          </InlineStack>
          <Button url="/app/ai-replies/settings">Settings</Button>
        </InlineStack>

        {s.received === 0 && (
          <Banner tone="info">
            No messages yet. Anything a shopper sends on WhatsApp or Instagram shows up here, along
            with what the bot replied.
          </Banner>
        )}

        {/* Messages arriving that cannot be answered is the one thing worth
            interrupting for, and the fix is one click away rather than described. */}
        {s.received > 0 && !d.aiReady && (
          <Banner
            tone="warning"
            title="Messages are arriving, but the bot is not answering"
            action={{ content: "Finish setup", url: "/app/ai-replies/settings" }}
          >
            <p>
              Automated replies are switched off or missing an AI key, so shoppers are waiting on a
              human for every message.
            </p>
          </Banner>
        )}

        {s.failed > 0 && (
          <Banner
            tone="critical"
            title={`${nfmt(s.failed)} ${s.failed === 1 ? "message" : "messages"} could not be answered`}
            action={{ content: "Check settings", url: "/app/ai-replies/settings" }}
          >
            <p>Usually an expired AI key or a WhatsApp send failure. The reason is in the table below.</p>
          </Banner>
        )}

        {/* Dim what is about to be replaced: showing the previous period's
            numbers at full strength during a load invites misreading them. */}
        <div style={dim}>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="300">
            <Stat
              label="Answered"
              value={nfmt(s.answered)}
              sub={`${nfmt(s.received)} messages received`}
            />
            <Stat
              label="Answer rate"
              value={`${s.answerRate}%`}
              sub={s.failed > 0 ? `${nfmt(s.failed)} failed` : "Of messages the bot took on"}
            />
            <Stat
              label="Handled by the bot"
              value={nfmt(s.handledByAi)}
              sub={
                s.shoppers > 0
                  ? `${Math.round((s.handledByAi / s.shoppers) * 100)}% of ${nfmt(s.shoppers)} customers`
                  : "No customers yet"
              }
            />
            <Stat
              label="Handled by a person"
              value={nfmt(s.handledByHuman)}
              sub={`${nfmt(s.handedOver)} chats handed over`}
            />
            <Stat
              label="Bot reply time"
              value={s.medianReplySeconds > 0 ? `${s.medianReplySeconds}s` : "-"}
              sub="Median, message in to reply out"
            />
          </InlineGrid>
        </div>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Customers handled, day by day</Text>
            <div style={dim}>
              <SplitTrend points={s.split} />
            </div>
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Where conversations go next</Text>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span">Shopper asked for a person</Text>
                  <Text as="span" fontWeight="semibold">{nfmt(s.askedForHuman)}</Text>
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span">Bot escalated on its own</Text>
                  <Text as="span" fontWeight="semibold">{nfmt(s.escalatedByBot)}</Text>
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span">Asked but never said what was wrong</Text>
                  <Text as="span" fontWeight="semibold">{nfmt(s.unresolvedHandovers)}</Text>
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span">WhatsApp / Instagram replies</Text>
                  <Text as="span" fontWeight="semibold">
                    {nfmt(s.waAnswered)} / {nfmt(s.igAnswered)}
                  </Text>
                </InlineStack>
              </BlockStack>
              <InlineStack gap="200">
                <Badge tone={d.aiReady ? "success" : "critical"}>
                  {d.aiReady ? "AI connected" : "AI not connected"}
                </Badge>
                <Badge tone={d.waReady ? "success" : undefined}>
                  {d.waReady ? "WhatsApp on" : "WhatsApp off"}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                A shopper who asked for a person keeps the bot out until they come back. An
                escalation the bot chose expires on its own.
              </Text>
            </BlockStack>
          </Card>

          <RankedList
            title="Why messages went unanswered"
            items={d.topSkips}
            empty="Every message got a reply."
          />

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Bot and team</Text>
              <Split
                label="Customers finished without a person"
                bot={s.handledByAi}
                human={s.handledByHuman}
              />
              <Box paddingBlockStart="100">
                <BlockStack gap="150">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span">Bot median reply time</Text>
                    <Text as="span" fontWeight="semibold">
                      {s.medianReplySeconds > 0 ? `${s.medianReplySeconds}s` : "-"}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span">Replied within a minute</Text>
                    <Text as="span" fontWeight="semibold">
                      {s.answered > 0
                        ? `${Math.round((s.repliesUnderAMinute / s.answered) * 100)}%`
                        : "-"}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Box>
              <Box paddingBlockStart="100">
                <BlockStack gap="150">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span">Handed to your team</Text>
                    <Text as="span" fontWeight="semibold">{nfmt(s.handedOver)}</Text>
                  </InlineStack>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" tone="subdued">Messages the bot could not answer</Text>
                    <Text as="span" tone="subdued">{nfmt(s.messagesToHuman)}</Text>
                  </InlineStack>
                </BlockStack>
              </Box>
              {/* Said plainly rather than filled in with a plausible number. Once
                  a chat is assigned, your team answers inside Interakt or
                  Instagram, and none of that comes back to this app. */}
              {s.handedOver === 0 && s.answered > 0 ? (
                <Banner tone="info">
                  <Text as="p" variant="bodySm">
                    Nothing was handed to a person in this period. If that looks wrong, check that
                    your team replies from the WhatsApp inbox after the bot steps out: a handover
                    is only counted once the bot has stopped answering that thread.
                  </Text>
                </Banner>
              ) : null}
              <Text as="p" variant="bodySm" tone="subdued">
                A customer counts as finished by the bot unless the chat was handed to a person.
                Your team's own reply time is not shown: that happens in Interakt or Instagram,
                which does not report back here.
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card padding="0">
          <Box padding="300">
            <Text as="h2" variant="headingMd">Recent messages</Text>
          </Box>
          <IndexTable
            resourceName={{ singular: "message", plural: "messages" }}
            itemCount={d.activity.length}
            selectable={false}
            headings={[
              { title: "Shopper" },
              { title: "Channel" },
              { title: "Message" },
              { title: "When" },
              { title: "Result" },
            ]}
          >
            {d.activity.map((a, i) => (
              <IndexTable.Row id={a.id} key={a.id} position={i}>
                <IndexTable.Cell>
                  {a.channel === "WhatsApp" ? (
                    // A tel: link is the only useful action: these numbers come
                    // from WhatsApp, not from a Shopify customer record.
                    <Link url={`tel:+91${a.who}`} removeUnderline>+91 {a.who}</Link>
                  ) : (
                    <Text as="span" tone="subdued">Instagram user</Text>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>{a.channel}</IndexTable.Cell>
                <IndexTable.Cell>
                  <span title={a.fullMessage}>{a.message || "No text"}</span>
                </IndexTable.Cell>
                {/* Exact time on hover: "2 hours ago" scans faster, but the real
                    timestamp is what someone reconciling a complaint needs. */}
                <IndexTable.Cell>
                  <span title={new Date(a.when).toLocaleString("en-IN")}>{ago(a.when)}</span>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {a.status === "done" ? (
                    <Badge tone="success">Answered</Badge>
                  ) : a.status === "failed" ? (
                    <span title={a.note}><Badge tone="critical">Failed</Badge></span>
                  ) : a.status === "skipped" ? (
                    <Badge>{a.note}</Badge>
                  ) : (
                    <Badge tone="attention">In queue</Badge>
                  )}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>

        {/* The embedded frame clips at the last element, so the table sat flush
            against the bottom edge with nothing to breathe into. */}
        <Box paddingBlockEnd="800" />
      </BlockStack>
    </Page>
  );
}
