"use client";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Lock, Globe, SlidersHorizontal } from "lucide-react";
import type { CollectionRules as Rules } from "@/lib/api";

const DEFAULT_RULES: Rules = {
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

const RULE_FIELDS = [
  { key: "listRule", label: "List Rule", hint: "Who can list records (GET .../records)" },
  { key: "viewRule", label: "View Rule", hint: "Who can view a single record (GET .../records/:id)" },
  { key: "createRule", label: "Create Rule", hint: "Who can create records (POST .../records)" },
  { key: "updateRule", label: "Update Rule", hint: "Who can update records (PATCH .../records/:id)" },
  { key: "deleteRule", label: "Delete Rule", hint: "Who can delete records (DELETE .../records/:id)" },
] as const;

interface RulesTabProps {
  rulesDraft: Rules | null;
  rulesSaving: boolean;
  rulesError: string;
  onRulesChange: (rules: Rules | ((prev: Rules | null) => Rules)) => void;
  onSaveRules: () => void;
}

export function RulesTab({
  rulesDraft,
  rulesSaving,
  rulesError,
  onRulesChange,
  onSaveRules,
}: RulesTabProps) {
  return (
    <Card className="p-6">
      <div className="mb-5">
        <h3 className="text-lg font-semibold">API Rules (Row-Level Security)</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Configure who can read, write, update, and delete data in this collection.
        </p>
      </div>

      {rulesError && (
        <div className="text-destructive text-sm font-medium mb-4">{rulesError}</div>
      )}

      <div className="grid gap-4">
        {RULE_FIELDS.map((r) => {
          const val = rulesDraft ? rulesDraft[r.key] : null;
          const isLocked = val === null || val === undefined;
          const isPublic = val === "";
          const isCustom = !isLocked && !isPublic;

          return (
            <div key={r.key} className="bg-muted p-4 rounded-lg border border-border">
              <div className="flex justify-between items-center mb-1.5">
                <div className="flex items-center gap-2">
                  <strong className="text-sm">{r.label}</strong>
                  {isLocked && (
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <Lock className="w-3 h-3" />
                      <span>Admin Only (null)</span>
                    </Badge>
                  )}
                  {isPublic && (
                    <Badge variant="green" className="gap-1 text-xs">
                      <Globe className="w-3 h-3" />
                      <span>Public ("")</span>
                    </Badge>
                  )}
                  {isCustom && (
                    <Badge variant="blue" className="gap-1 text-xs">
                      <SlidersHorizontal className="w-3 h-3" />
                      <span>Custom Rule</span>
                    </Badge>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2.5 text-xs gap-1"
                    onClick={() =>
                      onRulesChange((prev) => ({ ...(prev || DEFAULT_RULES), [r.key]: null }))
                    }
                  >
                    <Lock className="w-3 h-3" />
                    <span>Lock (null)</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2.5 text-xs gap-1"
                    onClick={() =>
                      onRulesChange((prev) => ({ ...(prev || DEFAULT_RULES), [r.key]: "" }))
                    }
                  >
                    <Globe className="w-3 h-3" />
                    <span>Public ("")</span>
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{r.hint}</p>
              <Input
                placeholder="null (admin only), or an expression: user = @request.auth.id"
                value={val === null || val === undefined ? "" : val}
                onChange={(e) => {
                  const nextVal = e.target.value === "" ? null : e.target.value;
                  onRulesChange((prev) => ({ ...(prev || DEFAULT_RULES), [r.key]: nextVal }));
                }}
                className="font-mono text-sm"
              />
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={onSaveRules} disabled={rulesSaving}>
          {rulesSaving ? "Saving Rules…" : "Save API Rules Changes"}
        </Button>
      </div>
    </Card>
  );
}
