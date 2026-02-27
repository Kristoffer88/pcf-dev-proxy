import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class DevProxySample implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private container!: HTMLDivElement;
    private shell!: HTMLDivElement;
    private status!: HTMLDivElement;
    private input!: HTMLInputElement;
    private notifyOutputChanged!: () => void;
    private currentValue = "";

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        console.log("[DevProxySample] init called");

        this.container = container;
        this.notifyOutputChanged = notifyOutputChanged;
        this.currentValue = context.parameters.sampleProperty.raw ?? "";

        this.shell = document.createElement("div");
        this.shell.style.padding = "10px";
        this.shell.style.borderRadius = "8px";
        this.shell.style.border = "2px solid #2d7d46";
        this.shell.style.background = "linear-gradient(135deg, #e9f6ec 0%, #f5fbf7 100%)";

        this.status = document.createElement("div");
        this.status.textContent = "HMR Active";
        this.status.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";
        this.status.style.fontSize = "12px";
        this.status.style.fontWeight = "600";
        this.status.style.color = "#1f5f35";
        this.status.style.marginBottom = "8px";

        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.value = this.currentValue;
        this.input.placeholder = "Type here - no full page reload needed";
        this.input.style.width = "100%";
        this.input.style.boxSizing = "border-box";
        this.input.style.padding = "8px";
        this.input.style.border = "2px solid #2d7d46";
        this.input.style.borderRadius = "4px";
        this.input.style.fontSize = "14px";
        this.input.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";

        this.input.addEventListener("input", this.onInput);
        this.shell.appendChild(this.status);
        this.shell.appendChild(this.input);
        this.container.appendChild(this.shell);

        void state; // suppress unused-param lint
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const incoming = context.parameters.sampleProperty.raw ?? "";
        if (incoming !== this.currentValue) {
            this.currentValue = incoming;
            this.input.value = incoming;
        }

        this.input.disabled = context.mode.isControlDisabled;
    }

    public getOutputs(): IOutputs {
        return {
            sampleProperty: this.currentValue,
        };
    }

    public destroy(): void {
        if (this.input) {
            this.input.removeEventListener("input", this.onInput);
        }
    }

    private onInput = (event: Event): void => {
        const nextValue = (event.target as HTMLInputElement).value;
        if (nextValue === this.currentValue) return;
        this.currentValue = nextValue;
        this.notifyOutputChanged();
    };
}
