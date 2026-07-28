import * as TypeORM from "typeorm";
import Model from "./common";

@TypeORM.Entity({ name: "clipboard_item" })
export default class ClipboardItem extends Model {
  static cache = false;

  @TypeORM.PrimaryGeneratedColumn()
  id: number;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  user_id: number;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  title: string;

  @TypeORM.Column({ nullable: true, type: "mediumtext" })
  content: string;

  @TypeORM.Index()
  @TypeORM.Column({ default: "private", type: "varchar", length: 20 })
  visibility: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 40 })
  share_token: string;

  @TypeORM.Column({ nullable: true, type: "integer" })
  share_expires: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  public_time: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  update_time: number;

  isOwnedBy(user: { id: number }): boolean {
    return user && this.user_id === user.id;
  }

  isShareLinkValid(): boolean {
    if (this.visibility !== "link" || !this.share_token) return false;
    if (!this.share_expires) return true;
    return Math.floor(Date.now() / 1000) < this.share_expires;
  }
}
