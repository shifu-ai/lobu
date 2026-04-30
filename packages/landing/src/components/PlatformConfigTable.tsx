import platformConfigs from "@platform-configs";

interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface Props {
  platform: string;
  showConnectionSettings?: boolean;
}

function FieldRow({ field }: { field: FieldInfo }) {
  return (
    <tr>
      <td>
        <code>{field.name}</code>
      </td>
      <td>{field.required ? "Yes" : "No"}</td>
      <td>
        <code>{field.type}</code>
      </td>
      <td>{field.description}</td>
    </tr>
  );
}

export function PlatformConfigTable({
  platform,
  showConnectionSettings = true,
}: Props) {
  const config = platformConfigs.platforms.find(
    (p: { platform: string }) => p.platform === platform
  );

  if (!config || config.fields.length === 0) return null;

  return (
    <div>
      <div class="overflow-x-auto">
        <table class="min-w-[36rem]">
          <thead>
            <tr>
              <th>Field</th>
              <th>Required</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {config.fields.map((field: FieldInfo) => (
              <FieldRow key={field.name} field={field} />
            ))}
          </tbody>
        </table>
      </div>

      {showConnectionSettings &&
        platformConfigs.connectionSettings.fields.length > 0 && (
          <>
            <h3>Connection Settings</h3>
            <p>
              These settings apply to all platform connections and are passed in
              the <code>settings</code> object.
            </p>
            <div class="overflow-x-auto">
              <table class="min-w-[36rem]">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Required</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {platformConfigs.connectionSettings.fields.map(
                    (field: FieldInfo) => (
                      <FieldRow key={field.name} field={field} />
                    )
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}
