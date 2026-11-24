use std::collections::BTreeMap;
use std::path::PathBuf;

use schemars::JsonSchema;
use serde_json::Value;
use ts_rs::{Config, ExportError, TS};

#[derive(Clone, Copy)]
pub struct TsRef {
    name: fn(&Config) -> String,
    imports: fn(&Config) -> Vec<(String, PathBuf)>,
    export: fn(&Config) -> Result<(), ExportError>,
    schema: Option<fn(bool) -> Value>,
}

impl std::fmt::Debug for TsRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("TsRef")
            .field(&(self.name)(&Config::new()))
            .finish()
    }
}

fn imports_of<T: TS + 'static + ?Sized>(cfg: &Config) -> Vec<(String, PathBuf)> {
    match T::output_path() {
        Some(path) => vec![(T::ident(cfg), path)],
        None => T::dependencies(cfg)
            .into_iter()
            .map(|d| (d.ts_name, d.output_path))
            .collect(),
    }
}

fn export_of<T: TS + 'static + ?Sized>(cfg: &Config) -> Result<(), ExportError> {
    if T::output_path().is_some() {
        T::export_all(cfg)
    } else {
        struct Visit<'a>(&'a Config, Result<(), ExportError>);
        impl ts_rs::TypeVisitor for Visit<'_> {
            fn visit<U: TS + 'static + ?Sized>(&mut self) {
                if self.1.is_ok() && U::output_path().is_some() {
                    self.1 = U::export_all(self.0);
                }
            }
        }
        let mut v = Visit(cfg, Ok(()));
        T::visit_dependencies(&mut v);
        v.1
    }
}

fn schema_of<T: JsonSchema>(for_input: bool) -> Value {
    tessera_tools::schema_for::<T>(for_input)
}

impl TsRef {
    pub fn of<T: TS + 'static>() -> Self {
        Self {
            name: T::name,
            imports: imports_of::<T>,
            export: export_of::<T>,
            schema: None,
        }
    }

    pub fn with_schema<T: TS + JsonSchema + 'static>() -> Self {
        Self {
            schema: Some(schema_of::<T>),
            ..Self::of::<T>()
        }
    }

    pub fn name(&self, cfg: &Config) -> String {
        (self.name)(cfg)
    }

    pub fn export(&self, cfg: &Config) -> Result<(), ExportError> {
        (self.export)(cfg)
    }

    pub fn schema(&self, for_input: bool) -> Option<Value> {
        self.schema.map(|f| f(for_input))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Served,
    Planned,
}

#[derive(Clone, Debug)]
pub struct ToolTs {
    pub name: &'static str,
    pub input: TsRef,
    pub output: TsRef,
    pub status: ToolStatus,
}

#[derive(Clone, Debug)]
pub struct TopicTs {
    pub name: &'static str,
    pub params: TsRef,
    pub data: TsRef,
}

#[derive(Clone, Debug)]
pub struct TsExports {
    pub origin: &'static str,
    pub types: Vec<TsRef>,
    pub tools: Vec<ToolTs>,
    pub topics: Vec<TopicTs>,
}

impl TsExports {
    pub fn new(origin: &'static str) -> Self {
        Self {
            origin,
            types: Vec::new(),
            tools: Vec::new(),
            topics: Vec::new(),
        }
    }

    pub fn ty<T: TS + 'static>(mut self) -> Self {
        self.types.push(TsRef::of::<T>());
        self
    }

    pub fn tool<I, O>(mut self, name: &'static str) -> Self
    where
        I: TS + JsonSchema + 'static,
        O: TS + JsonSchema + 'static,
    {
        self.tools.push(ToolTs {
            name,
            input: TsRef::with_schema::<I>(),
            output: TsRef::with_schema::<O>(),
            status: ToolStatus::Served,
        });
        self
    }

    pub fn planned_tool<I, O>(mut self, name: &'static str) -> Self
    where
        I: TS + JsonSchema + 'static,
        O: TS + JsonSchema + 'static,
    {
        self.tools.push(ToolTs {
            name,
            input: TsRef::with_schema::<I>(),
            output: TsRef::with_schema::<O>(),
            status: ToolStatus::Planned,
        });
        self
    }

    pub fn topic<P: TS + 'static, D: TS + 'static>(mut self, name: &'static str) -> Self {
        self.topics.push(TopicTs {
            name,
            params: TsRef::of::<P>(),
            data: TsRef::of::<D>(),
        });
        self
    }

    pub fn export(&self, cfg: &Config) -> Result<(), ExportError> {
        for t in &self.types {
            t.export(cfg)?;
        }
        for t in &self.tools {
            t.input.export(cfg)?;
            t.output.export(cfg)?;
        }
        for t in &self.topics {
            t.params.export(cfg)?;
            t.data.export(cfg)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeclarationError {
    #[error("tool {0} is declared by both {1} and {2}")]
    DuplicateTool(String, &'static str, &'static str),
    #[error("topic {0} is declared by both {1} and {2}")]
    DuplicateTopic(String, &'static str, &'static str),
}

pub fn check_declarations(all: &[TsExports]) -> Result<(), DeclarationError> {
    let mut tools: BTreeMap<&str, &'static str> = BTreeMap::new();
    let mut topics: BTreeMap<&str, &'static str> = BTreeMap::new();
    for e in all {
        for t in &e.tools {
            if let Some(other) = tools.insert(t.name, e.origin) {
                return Err(DeclarationError::DuplicateTool(
                    t.name.to_owned(),
                    other,
                    e.origin,
                ));
            }
        }
        for t in &e.topics {
            if let Some(other) = topics.insert(t.name, e.origin) {
                return Err(DeclarationError::DuplicateTopic(
                    t.name.to_owned(),
                    other,
                    e.origin,
                ));
            }
        }
    }
    Ok(())
}

const HEADER: &str = "// Generated by tessera-gen (crates/tessera-runtime) from each crate's ts_exports(). Do not edit.\n\
// Regenerate with: bun run gen\n";

fn import_block(refs: &[&TsRef], cfg: &Config) -> String {
    let mut imports: BTreeMap<String, String> = BTreeMap::new();
    for r in refs {
        for (ident, path) in (r.imports)(cfg) {
            let module = path
                .with_extension("")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            imports.insert(ident, module);
        }
    }
    imports
        .into_iter()
        .map(|(ident, module)| format!("import type {{ {ident} }} from \"./{module}\";\n"))
        .collect()
}

pub fn tool_map_ts(all: &[TsExports], cfg: &Config) -> String {
    let mut tools: Vec<(&ToolTs, &'static str)> = all
        .iter()
        .flat_map(|e| e.tools.iter().map(move |t| (t, e.origin)))
        .collect();
    tools.sort_by_key(|(t, _)| t.name);
    let refs: Vec<&TsRef> = tools
        .iter()
        .flat_map(|(t, _)| [&t.input, &t.output])
        .collect();
    let mut out = String::from(HEADER);
    out.push_str(&import_block(&refs, cfg));
    out.push_str(
        "\n/**\n * Tool name → input and output types, for every tool in the runtime's contract.\n * \
         Planned tools are typed ahead of the wave that serves them: feature-detect them with \
         `tools.list`.\n */\nexport interface ToolMap {\n",
    );
    for (t, origin) in tools {
        let note = match t.status {
            ToolStatus::Served => origin.to_owned(),
            ToolStatus::Planned => format!("{origin}; planned, not served yet"),
        };
        out.push_str(&format!(
            "  /** {note} */\n  \"{}\": {{ input: {}; output: {} }};\n",
            t.name,
            t.input.name(cfg),
            t.output.name(cfg)
        ));
    }
    out.push_str("}\n");
    out
}

pub fn topic_map_ts(all: &[TsExports], cfg: &Config) -> String {
    let mut topics: Vec<(&TopicTs, &'static str)> = all
        .iter()
        .flat_map(|e| e.topics.iter().map(move |t| (t, e.origin)))
        .collect();
    topics.sort_by_key(|(t, _)| t.name);
    let refs: Vec<&TsRef> = topics
        .iter()
        .flat_map(|(t, _)| [&t.params, &t.data])
        .collect();
    let mut out = String::from(HEADER);
    out.push_str(&import_block(&refs, cfg));
    out.push_str(
        "\n/** Topic name → subscribe params and event `data`, for every topic the runtime serves. */\n\
         export interface TopicMap {\n",
    );
    for (t, origin) in topics {
        out.push_str(&format!(
            "  /** {origin} */\n  \"{}\": {{ params: {}; data: {} }};\n",
            t.name,
            t.params.name(cfg),
            t.data.name(cfg)
        ));
    }
    out.push_str("}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, TS, JsonSchema)]
    struct SampleInput {
        a: u32,
    }

    #[derive(Serialize, Deserialize, TS, JsonSchema)]
    struct SampleOutput {
        items: Vec<SampleInput>,
    }

    #[test]
    fn maps_are_sorted_typed_and_import_their_types() {
        let cfg = Config::new();
        let a = TsExports::new("crate-a")
            .tool::<SampleInput, SampleOutput>("sample.run")
            .planned_tool::<SampleInput, Vec<SampleOutput>>("sample.later")
            .topic::<SampleInput, SampleOutput>("sample.events");
        let tools = tool_map_ts(std::slice::from_ref(&a), &cfg);
        assert!(tools.contains("import type { SampleInput } from \"./SampleInput\";"));
        assert!(tools.contains("import type { SampleOutput } from \"./SampleOutput\";"));
        let later = tools.find("\"sample.later\"").unwrap();
        let run = tools.find("\"sample.run\"").unwrap();
        assert!(later < run, "sorted by name");
        assert!(
            tools
                .contains("\"sample.later\": { input: SampleInput; output: Array<SampleOutput> };")
        );
        assert!(tools.contains("planned, not served yet"));
        let topics = topic_map_ts(std::slice::from_ref(&a), &cfg);
        assert!(topics.contains("\"sample.events\": { params: SampleInput; data: SampleOutput };"));
        assert_eq!(
            a.tools[0].input.schema(true),
            Some(tessera_tools::schema_for::<SampleInput>(true))
        );
        let b = TsExports::new("crate-b").tool::<SampleInput, SampleOutput>("sample.run");
        assert!(matches!(
            check_declarations(&[a, b]),
            Err(DeclarationError::DuplicateTool(..))
        ));
    }
}
