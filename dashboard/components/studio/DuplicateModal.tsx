"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

interface DuplicateModalProps {
  open: boolean;
  collectionName: string;
  duplicateName: string;
  duplicateWithData: boolean;
  onNameChange: (name: string) => void;
  onWithDataChange: (withData: boolean) => void;
  onCancel: () => void;
  onDuplicate: () => void;
}

export function DuplicateModal({
  open,
  collectionName,
  duplicateName,
  duplicateWithData,
  onNameChange,
  onWithDataChange,
  onCancel,
  onDuplicate,
}: DuplicateModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o: boolean) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate Collection "{collectionName}"</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dup-name">Nama Collection Baru</Label>
            <Input
              id="dup-name"
              value={duplicateName}
              onChange={(e) =>
                onNameChange(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
              }
              placeholder="nama_koleksi_baru"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={duplicateWithData}
              onCheckedChange={(checked) => onWithDataChange(!!checked)}
            />
            <span>Include all record data rows (withData)</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onDuplicate}>Duplicate Collection</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
