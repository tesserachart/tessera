use std::collections::HashMap;

use serde_json::json;
use tessera_core::ids::AccountId;
use tessera_core::orders::{OrderRole, Position, Side};
use tessera_protocol::tools::ToolErrorCode;
use tessera_tools::{ToolCtx, ToolError};

use super::book::{AccountFacts, name_of, on_rules, shape_rules, stopped_copying};
use super::io::{
    CopyCreateInput, CopyDeleteOutput, CopyFollowerView, CopyGroupOutput, CopyGroupView,
    CopyListInput, CopyListOutput, CopyUpdateInput,
};
use super::model::{CopyGroup, CopyNote};
use crate::BrokerError;
use crate::orders::io::CancelOrderInput;
use crate::orders::{OrdersService, broker_error};
use crate::paper::engine::qty_label;

fn holding(p: &Position) -> String {
    format!(
        "{} {} {}",
        if p.side() == Some(Side::Sell) {
            "Short"
        } else {
            "Long"
        },
        qty_label(p.qty.abs()),
        p.instrument.symbol()
    )
}

#[derive(Clone, Copy)]
struct Asked<'a> {
    ctx: &'a ToolCtx,
    tool: &'static str,
}

impl OrdersService {
    async fn replace_groups(
        &self,
        asked: Asked<'_>,
        groups: Vec<CopyGroup>,
    ) -> Result<Vec<String>, ToolError> {
        let before = self.copying.book.groups();
        let stopped = stopped_copying(&before, &groups);
        self.copying
            .book
            .replace(groups)
            .await
            .map_err(ToolError::internal)?;
        Ok(self.cancel_orphans(asked, stopped).await)
    }

    async fn cancel_orphans(
        &self,
        asked: Asked<'_>,
        stopped: Vec<(CopyGroup, AccountId)>,
    ) -> Vec<String> {
        let mut said = Vec::new();
        for (group, follower) in stopped {
            let _turn = self.leader_turn(&group.leader_id).await;
            let linked = self.copies_of_leader(&group.leader_id, &follower);
            if linked.is_empty() {
                continue;
            }
            let name = self.account_name(follower.as_str()).await;
            let leader_name = self.account_name(group.leader_id.as_str()).await;
            let orders = match self.provider_ref().orders(&follower).await {
                Ok(o) => o,
                Err(e) => {
                    said.push(format!(
                        "{name}'s orders could not be read, so its working copies of \
                         {leader_name}'s orders may still work: {}.",
                        broker_error(e).message.trim_end_matches('.')
                    ));
                    continue;
                }
            };
            let entries = orders.iter().filter(|o| {
                linked.contains(&o.id)
                    && o.status.is_open()
                    && o.role == OrderRole::Entry
                    && o.parent_id.is_none()
                    && !o.request.reduce_only
            });
            for o in entries {
                let sentence = self.sentence(o).await;
                let cancel = CancelOrderInput {
                    account_id: follower.to_string(),
                    order_id: o.id.clone(),
                };
                let r = self.cancel(&cancel).await;
                let summary = r
                    .as_ref()
                    .map(|_| format!("cancelled {sentence}"))
                    .map_err(Clone::clone);
                self.audit_copy(
                    asked.ctx,
                    &group,
                    &leader_name,
                    &follower,
                    asked.tool,
                    json!(cancel),
                    &summary,
                );
                match r {
                    Ok(_) => said.push(format!("Cancelled {name}'s working copy of {sentence}.")),
                    Err(e) if e.code == ToolErrorCode::Conflict => {}
                    Err(e) => said.push(format!(
                        "Could not cancel {name}'s working copy of {sentence}: {}.",
                        e.message.trim_end_matches('.')
                    )),
                }
            }
        }
        said
    }

    async fn account_facts(&self) -> Result<HashMap<AccountId, AccountFacts>, ToolError> {
        let accounts = self.provider_ref().accounts().await.map_err(broker_error)?;
        let mut out = HashMap::with_capacity(accounts.len());
        for a in accounts {
            let cannot_follow = match self.broker().route(&a.id).await {
                Ok(_) => None,
                Err(BrokerError::Refused(why)) => Some(why.to_string()),
                Err(e) => Some(e.to_string()),
            };
            out.insert(
                a.id,
                AccountFacts {
                    name: a.display_name,
                    cannot_follow,
                },
            );
        }
        Ok(out)
    }

    fn view(group: &CopyGroup, facts: &HashMap<AccountId, AccountFacts>) -> CopyGroupView {
        CopyGroupView {
            id: group.id.clone(),
            name: group.name.clone(),
            leader_id: group.leader_id.clone(),
            leader: name_of(facts, &group.leader_id),
            enabled: group.enabled,
            followers: group
                .followers
                .iter()
                .map(|f| CopyFollowerView {
                    account_id: f.account_id.clone(),
                    account: name_of(facts, &f.account_id),
                    multiplier: f.multiplier,
                    fixed_qty: f.fixed_qty,
                    sizing: f.sizing_words(),
                    micro: f.micro,
                    paused: f.paused,
                    cannot_follow: facts.get(&f.account_id).map_or_else(
                        || Some("not connected".to_owned()),
                        |x| x.cannot_follow.clone(),
                    ),
                })
                .collect(),
            created_at: group.created_at,
            updated_at: group.updated_at,
        }
    }

    pub async fn copy_list(&self, input: &CopyListInput) -> Result<CopyListOutput, ToolError> {
        let facts = self.account_facts().await?;
        let only = input.account_id.as_deref().map(AccountId::new);
        let groups = self
            .copying
            .book
            .groups()
            .iter()
            .filter(|g| {
                only.as_ref()
                    .is_none_or(|a| &g.leader_id == a || g.follower(a).is_some())
            })
            .map(|g| Self::view(g, &facts))
            .collect();
        Ok(CopyListOutput { groups })
    }

    async fn positions_said(
        &self,
        group: &CopyGroup,
        facts: &HashMap<AccountId, AccountFacts>,
    ) -> Vec<String> {
        let mut said = Vec::new();
        let leader = name_of(facts, &group.leader_id);
        let accounts =
            std::iter::once(&group.leader_id).chain(group.followers.iter().map(|f| &f.account_id));
        for a in accounts {
            let name = name_of(facts, a);
            let held: Vec<Position> = match self.provider_ref().positions(a).await {
                Ok(v) => v.into_iter().filter(|p| !p.qty.is_zero()).collect(),
                Err(e) => {
                    said.push(format!(
                        "{name}'s positions could not be read ({}): its sync is unknown until \
                         they can be.",
                        broker_error(e).message.trim_end_matches('.')
                    ));
                    continue;
                }
            };
            if held.is_empty() {
                continue;
            }
            let held = held.iter().map(holding).collect::<Vec<_>>().join(", ");
            said.push(if a == &group.leader_id {
                format!(
                    "{leader} already holds {held}: copying starts with its next order; resync \
                     puts the followers at their size."
                )
            } else {
                format!(
                    "{name} already holds {held}: copies never take it past its size, and \
                     resync puts it at its size; {leader}'s last exit there closes it, as its \
                     flatten does."
                )
            });
        }
        said
    }

    fn turn_on(
        groups: &mut [CopyGroup],
        id: &str,
        facts: &HashMap<AccountId, AccountFacts>,
        now: tessera_core::Timestamp,
    ) -> Result<Vec<String>, ToolError> {
        let Some(at) = groups.iter().position(|g| g.id == id) else {
            return Err(ToolError::not_found(format!("no copy group {id}")));
        };
        shape_rules(&groups[at], facts).map_err(ToolError::rejected)?;
        let replaced = on_rules(&groups[at], groups, facts).map_err(ToolError::rejected)?;
        let mut said = Vec::new();
        if let Some(r) = replaced
            && let Some(other) = groups.iter_mut().find(|g| g.id == r)
        {
            other.enabled = false;
            other.updated_at = now;
            said.push(format!(
                "Turned {} off: one group copies a leader at a time.",
                other.name
            ));
        }
        groups[at].enabled = true;
        groups[at].updated_at = now;
        Ok(said)
    }

    async fn keep(
        &self,
        asked: Asked<'_>,
        groups: Vec<CopyGroup>,
        id: &str,
        mut said: Vec<String>,
        facts: &HashMap<AccountId, AccountFacts>,
        turned_on: bool,
    ) -> Result<CopyGroupOutput, ToolError> {
        let group = groups
            .iter()
            .find(|g| g.id == id)
            .cloned()
            .ok_or_else(|| ToolError::not_found(format!("no copy group {id}")))?;
        if turned_on {
            said.extend(self.positions_said(&group, facts).await);
        }
        said.extend(self.replace_groups(asked, groups).await?);
        if turned_on && !said.is_empty() {
            self.copying.book.say(CopyNote {
                group_id: group.id.clone(),
                leader_id: group.leader_id.clone(),
                title: format!("{} is on", group.name),
                detail: said.join(" "),
                tone: "info".into(),
                ts: self.clock_ref().now(),
            });
        }
        tracing::info!(group = %group.id, enabled = group.enabled, "copy group changed");
        Ok(CopyGroupOutput {
            group: Self::view(&group, facts),
            said,
        })
    }

    pub async fn copy_create(
        &self,
        ctx: &ToolCtx,
        input: &CopyCreateInput,
    ) -> Result<CopyGroupOutput, ToolError> {
        let _one = self.copying.manage.lock().await;
        let facts = self.account_facts().await?;
        let leader = AccountId::new(input.leader_id.trim());
        let now = self.clock_ref().now();
        let name = input
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map_or_else(
                || format!("Copy {}", name_of(&facts, &leader)),
                str::to_owned,
            );
        let group = CopyGroup {
            id: self.copying.book.next_id(),
            name,
            leader_id: leader,
            followers: input.followers.clone(),
            enabled: false,
            created_at: now,
            updated_at: now,
        };
        shape_rules(&group, &facts).map_err(ToolError::rejected)?;
        let id = group.id.clone();
        let mut groups = self.copying.book.groups();
        groups.push(group);
        let on = input.enabled == Some(true);
        let said = if on {
            Self::turn_on(&mut groups, &id, &facts, now)?
        } else {
            Vec::new()
        };
        let asked = Asked {
            ctx,
            tool: "copy.create",
        };
        self.keep(asked, groups, &id, said, &facts, on).await
    }

    pub async fn copy_update(
        &self,
        ctx: &ToolCtx,
        input: &CopyUpdateInput,
    ) -> Result<CopyGroupOutput, ToolError> {
        let _one = self.copying.manage.lock().await;
        let mut facts = self.account_facts().await?;
        let mut groups = self.copying.book.groups();
        let Some(at) = groups.iter().position(|g| g.id == input.group_id) else {
            return Err(ToolError::not_found(format!(
                "no copy group {}",
                input.group_id
            )));
        };
        let now = self.clock_ref().now();
        let was = groups[at].clone();
        let g = &mut groups[at];
        if let Some(n) = &input.name {
            g.name = n.trim().to_owned();
        }
        if let Some(l) = &input.leader_id {
            g.leader_id = AccountId::new(l.trim());
        }
        if let Some(f) = &input.followers {
            g.followers = f.clone();
        }
        g.updated_at = now;
        for f in &was.followers {
            if g.leader_id == was.leader_id
                && let Some(x) = facts.get_mut(&f.account_id)
            {
                x.cannot_follow = None;
            }
        }
        shape_rules(g, &facts).map_err(ToolError::rejected)?;
        let changed = g.clone();
        let mut said = Vec::new();
        if changed.enabled {
            let replaced = on_rules(&changed, &groups, &facts).map_err(ToolError::rejected)?;
            if let Some(r) = replaced
                && let Some(other) = groups.iter_mut().find(|x| x.id == r)
            {
                other.enabled = false;
                other.updated_at = now;
                said.push(format!(
                    "Turned {} off: one group copies a leader at a time.",
                    other.name
                ));
            }
        }
        let id = input.group_id.clone();
        let asked = Asked {
            ctx,
            tool: "copy.update",
        };
        self.keep(asked, groups, &id, said, &facts, false).await
    }

    pub async fn copy_enable(&self, ctx: &ToolCtx, id: &str) -> Result<CopyGroupOutput, ToolError> {
        let _one = self.copying.manage.lock().await;
        let facts = self.account_facts().await?;
        let mut groups = self.copying.book.groups();
        let now = self.clock_ref().now();
        let said = Self::turn_on(&mut groups, id, &facts, now)?;
        let asked = Asked {
            ctx,
            tool: "copy.enable",
        };
        self.keep(asked, groups, id, said, &facts, true).await
    }

    pub async fn copy_disable(
        &self,
        ctx: &ToolCtx,
        id: &str,
    ) -> Result<CopyGroupOutput, ToolError> {
        let _one = self.copying.manage.lock().await;
        let facts = self.account_facts().await?;
        let mut groups = self.copying.book.groups();
        let Some(g) = groups.iter_mut().find(|g| g.id == id) else {
            return Err(ToolError::not_found(format!("no copy group {id}")));
        };
        if g.enabled {
            g.enabled = false;
            g.updated_at = self.clock_ref().now();
        }
        let asked = Asked {
            ctx,
            tool: "copy.disable",
        };
        self.keep(asked, groups, id, Vec::new(), &facts, false)
            .await
    }

    pub async fn copy_delete(
        &self,
        ctx: &ToolCtx,
        id: &str,
    ) -> Result<CopyDeleteOutput, ToolError> {
        let _one = self.copying.manage.lock().await;
        let mut groups = self.copying.book.groups();
        let Some(at) = groups.iter().position(|g| g.id == id) else {
            return Err(ToolError::not_found(format!("no copy group {id}")));
        };
        let gone = groups.remove(at);
        let asked = Asked {
            ctx,
            tool: "copy.delete",
        };
        let said = self.replace_groups(asked, groups).await?;
        Ok(CopyDeleteOutput {
            group_id: gone.id,
            name: gone.name,
            said,
        })
    }
}
