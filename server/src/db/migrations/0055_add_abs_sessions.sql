CREATE TABLE "abs_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"refresh_token" text NOT NULL,
	"last_refresh_token" text,
	"last_refresh_token_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "abs_sessions" ADD CONSTRAINT "abs_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abs_sessions_user_id_idx" ON "abs_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "abs_sessions_refresh_token_idx" ON "abs_sessions" USING btree ("refresh_token");--> statement-breakpoint
CREATE INDEX "abs_sessions_last_refresh_token_idx" ON "abs_sessions" USING btree ("last_refresh_token");