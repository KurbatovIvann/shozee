import { memo } from "react";
import { LayersIcon, TagIcon, UsersIcon } from "lucide-react-native";
import { useUnistyles } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import { EntityAvatar, EntityCard } from "../shared/entity-card";
import { EntityMetaLine } from "../shared/entity-meta-line";
import { groupRowActions } from "./groups-list.presenter";

export const GroupRow = memo(function GroupRow(props: {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly membersLabel: string;
  readonly priceListName: string | null;
  readonly editLabel: string;
  readonly deleteA11y: string;
  readonly canEdit: boolean;
  readonly disabled: boolean;
  readonly onEdit: (id: string) => void;
  readonly onRemove: (id: string) => void;
}) {
  const { theme } = useUnistyles();
  const actions = groupRowActions(props.canEdit);
  const iconColor = theme.colors.icon.muted;
  const iconSize = theme.iconSize.sm;

  return (
    <EntityCard
      title={props.name}
      avatar={
        <EntityAvatar>
          <LayersIcon size={iconSize} color={theme.colors.foreground} />
        </EntityAvatar>
      }
      badges={<StatusPill label={props.membersLabel} />}
      meta={
        <>
          {props.description !== null && props.description.length > 0 ? (
            <EntityMetaLine
              icon={<UsersIcon size={iconSize} color={iconColor} />}
            >
              {props.description}
            </EntityMetaLine>
          ) : null}
          {props.priceListName !== null ? (
            <EntityMetaLine
              icon={<TagIcon size={iconSize} color={iconColor} />}
            >
              {props.priceListName}
            </EntityMetaLine>
          ) : null}
        </>
      }
      editLabel={props.editLabel}
      showEdit={actions.showEdit}
      onEdit={() => {
        props.onEdit(props.id);
      }}
      removeLabel={props.deleteA11y}
      removeMode="delete"
      showRemove={actions.showDelete}
      onRemove={() => {
        props.onRemove(props.id);
      }}
      disabled={props.disabled}
    />
  );
});
