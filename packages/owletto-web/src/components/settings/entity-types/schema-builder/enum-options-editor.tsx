import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface EnumOptionsEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
}

export function EnumOptionsEditor({ options, onChange }: EnumOptionsEditorProps) {
  const [newOption, setNewOption] = useState('');

  const addOption = () => {
    const trimmed = newOption.trim();
    if (trimmed && !options.includes(trimmed)) {
      onChange([...options, trimmed]);
      setNewOption('');
    }
  };

  const removeOption = (index: number) => {
    onChange(options.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2 pl-4 border-l-2 border-muted">
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt, i) => (
          <span
            key={opt}
            className="inline-flex items-center gap-1 bg-muted text-sm px-2 py-0.5 rounded"
          >
            {opt}
            <button
              type="button"
              onClick={() => removeOption(i)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={newOption}
          onChange={(e) => setNewOption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addOption();
            }
          }}
          placeholder="Add option..."
          className="h-7 text-sm"
        />
        <Button type="button" variant="outline" size="sm" className="h-7 px-2" onClick={addOption}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
