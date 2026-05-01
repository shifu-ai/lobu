const cellStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-page-border)",
  fontSize: "13px",
  color: "var(--color-page-text-muted)",
};

const headerCellStyle = {
  ...cellStyle,
  fontWeight: 600,
  color: "var(--color-page-text)",
  backgroundColor: "var(--color-page-surface-dim)",
};

const starterSkills = [
  {
    product: "Lobu",
    install: "Enable from the agent settings UI",
    adds: "The Lobu starter skill in skills/lobu/ (includes memory guidance)",
  },
];

export function SkillsRegistryTable() {
  return (
    <div>
      <h2>Starter Skills</h2>
      <p>
        Lobu ships one starter skill. Lobu also discovers local skills from{" "}
        <code>skills/&lt;name&gt;/SKILL.md</code> or{" "}
        <code>agents/&lt;agent-id&gt;/skills/&lt;name&gt;/SKILL.md</code>.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            border: "1px solid var(--color-page-border)",
          }}
        >
          <thead>
            <tr>
              <th style={headerCellStyle}>Product</th>
              <th style={headerCellStyle}>Install</th>
              <th style={headerCellStyle}>What it adds</th>
            </tr>
          </thead>
          <tbody>
            {starterSkills.map((skill) => (
              <tr key={skill.install}>
                <td style={cellStyle}>{skill.product}</td>
                <td style={cellStyle}>
                  <code>{skill.install}</code>
                </td>
                <td style={cellStyle}>{skill.adds}</td>
              </tr>
            ))}
            <tr>
              <td style={cellStyle}>Local skill</td>
              <td style={cellStyle}>
                <code>skills/&lt;name&gt;/SKILL.md</code> or{" "}
                <code>
                  agents/&lt;agent-id&gt;/skills/&lt;name&gt;/SKILL.md
                </code>
              </td>
              <td style={cellStyle}>
                A project-owned custom skill discovered automatically
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
