import Rete, {Engine, Input, Output, Socket} from 'rete'
import {Node} from 'rete/types/node'
import {NodeEditor} from 'rete/types/editor'
import {LabelControl, LangTypeSelectControl, MultilineLabelControl, NumControl, TextInputControl, CheckBoxControl, AutocomplitComboBoxControl, ComboBoxControl} from "./controls"
import {LangCoreDesc, LangDesc, LangFunctionDesc, LangTypeDesc, LangExtraInfo} from "./lang"
import {Component} from "rete/types"
import { CompileError } from './rpc'


const optimizeFlow = true

const flowSocket = new Rete.Socket('exec-flow')


class LangCtx {
    allTypes = new Map</*mn*/string, LangType>()
    allFunctions = new Array<LangFunction>()
    allFuncAnnotations: Array<string>
    anyType: LangType
    logicType: LangType

    getType(mn: string): LangType | undefined {
        return this.allTypes.get(mn)
    }
}


class LangSocket extends Socket {
    typeName: string
    isAny: boolean

    constructor(typeName: string, isAny: boolean) {
        super(typeName)
        this.typeName = typeName
        this.isAny = isAny;
    }

    compatibleWith(socket: Socket): boolean {
        if (this === socket)
            return true
        if (socket instanceof LangSocket) {
            if (socket.isAny)
                return true
            return socket.typeName == this.typeName
        }
        return false
    }
}


export class LangType {
    constructor(typeDesc: LangTypeDesc, isVoid: boolean, isAny: boolean) {
        this.desc = typeDesc
        if (typeDesc.validator)
            this.validator = new RegExp(typeDesc.validator)
        this.isVoid = isVoid
        this.isAny = isAny
        this.isIterable = typeDesc.isIterable
        this.socket = new LangSocket(this.desc.baseMn ?? this.desc.mn, this.isAny)
    }

    readonly desc: LangTypeDesc
    readonly isVoid: boolean
    readonly isIterable?: boolean
    readonly isAny: boolean;
    readonly validator?: RegExp

    readonly socket: LangSocket

    getSocket(): LangSocket {
        return this.socket
    }

    ctor(s: string, args: { [key: string]: string }): string {
        if (!this.desc.ctor)
            return s
        const argsKeys = Object.keys(args)
        if (argsKeys.length > 0) {
            let res = this.desc.ctor
            for (const argName of argsKeys)
                res = res.replace(`\$${argName}`, args[argName])
            return res
        }
        return this.desc.ctor.replace('$', s) ?? s
    }

    supportTextInput() {
        return this.desc.validator || this.desc.ctor || this.desc.enum
    }
}

export class LangFunction {
    readonly desc: LangFunctionDesc

    constructor(desc: LangFunctionDesc) {
        this.desc = desc
    }

    static validate(desc: LangFunctionDesc, langCtx: LangCtx): boolean {
        for (const arg of desc.args) {
            const argType = langCtx.getType(arg.mn)
            if (!argType) {
                console.error(`Function's ${desc.name} argument ${arg.name} with unknown type ${arg.mn}`)
                return false
            }
            if (argType.isVoid) {
                console.error(`Function's ${desc.name} argument ${arg.name} is void`)
                return false
            }
        }
        const resType = langCtx.getType(desc.resMn)
        if (!resType) {
            console.error(`function ${desc.name} has unknown result type ${desc.resMn}`)
            return false
        }
        return true
    }

    ctor(args: { [key: string]: string }): string {
        if (!this.desc.ctor) {
            const argsStr = this.desc.args.map(arg => args[arg.name]).join(', ')
            return `${this.desc.name}(${argsStr})`
        }
        let res = this.desc.ctor
        for (let arg of this.desc.args)
            res = res.replace(`\$${arg.name}`, args[arg.name])
        return res
    }
}


export function generateCoreNodes(langCore: LangCoreDesc, lang: LangDesc, extra: LangExtraInfo, editor: NodeEditor, engine: Engine) {
    const langCtx = new LangCtx()
    const coreTypes = new Map</*mn*/string, LangTypeDesc>()
    langCtx.allFuncAnnotations = [...extra.funcAnnotations]

    for (const typeDesc of langCore.types ?? [])
        coreTypes.set(typeDesc.mn, typeDesc)

    for (const typeDesc of lang.types ?? []) {
        if (langCore.anyTypes.indexOf(typeDesc.mn) >= 0) {
            const type = new LangType(typeDesc, langCore.voidTypes.indexOf(typeDesc.mn) >= 0, true)
            langCtx.allTypes.set(typeDesc.mn, type)
            break
        }
    }

    for (const typeDesc of lang.types ?? []) {
        if (langCore.anyTypes.indexOf(typeDesc.mn) >= 0)
            continue
        if (langCtx.allTypes.has(typeDesc.mn)) {
            console.error(`type ${typeDesc.mn} already exists`)
        }
        const coreType = !typeDesc.isRef && typeDesc.baseMn ? coreTypes.get(typeDesc.baseMn) ?? coreTypes.get(typeDesc.mn) : coreTypes.get(typeDesc.mn)
        const mergeTypeDesc = coreType ? Object.assign({}, typeDesc, coreType) : typeDesc
        const type = new LangType(mergeTypeDesc, langCore.voidTypes.indexOf(typeDesc.mn) >= 0, false)
        langCtx.allTypes.set(typeDesc.mn, type)

        if (typeDesc.mn == langCore.logicType)
            langCtx.logicType = type
    }

    for (const type of langCtx.allTypes.values()) {
        if (type.isAny) {
            langCtx.anyType = type
            break
        }
    }

    const comps: Component[] = [new InjectTopLevelCode(), new InjectCode(), new Sequence(), new Var(langCtx),
        new Function(langCtx), new If(langCtx), new While(langCtx), new For(langCtx), new ModuleComponent(),
        new InputComponent(langCtx), new OutputComponent(langCtx), new InputFlowComponent(), new OutputFlowComponent(),
        new SetValue(langCtx)]

    for (const coreType of coreTypes.values()) {
        if (langCore.voidTypes.indexOf(coreType.mn) >= 0 || langCore.anyTypes.indexOf(coreType.mn) >= 0)
            continue
        const type = langCtx.allTypes.get(coreType.mn)
        if (type?.supportTextInput())
            comps.push(new TypeCtor(type.desc.typeName, ["ctors", type.desc.typeName], type))
    }

    for (const func of lang.functions ?? []) {
        if (!LangFunction.validate(func, langCtx))
            continue
        const langFunction = new LangFunction(func)
        const resType = langCtx.getType(func.resMn)
        if (!resType)
            continue
        langCtx.allFunctions.push(langFunction)
        const group: string[] = []
        if (langCore.voidTypes.indexOf(func.resMn) < 0 && langCore.anyTypes.indexOf(func.resMn) < 0 && resType.desc.typeName == func.name) {
            group.push("ctors", resType.desc.typeName)
        } else {
            const typeName = resType.desc.typeName
            group.push('functions', typeName.substring(0, 2), func.args.length.toString(), typeName, func.name.substring(0, 1))
        }
        const fn = new LangFunc(func.mn, group, langFunction, resType, langCtx)
        comps.push(fn)
    }

    for (const func of langCore.functions ?? []) {
        if (!LangFunction.validate(func, langCtx))
            continue
        const langFunction = new LangFunction(func)
        const resType = langCtx.getType(func.resMn)
        if (!resType)
            continue
        langCtx.allFunctions.push(langFunction)
        const fn = new LangFunc(func.mn, ['core'], langFunction, resType, langCtx)
        comps.push(fn)
    }

    for (let comp of comps) {
        engine.register(comp)
        editor.register(comp)
    }
}


export abstract class LangComponent extends Rete.Component {
    group: string[] // context menu path

    get topLevel(): boolean {
        return this._topLevel
    }

    private lazyInit = true
    private flowOut = false
    protected _topLevel = false

    protected constructor(name: string, group: string[] = ['language']) {
        super(name)
        this.group = group
    }

    worker(node, inputs, outputs) {
    }

    addFlowIn(node: Node, key = 'fin'): Input {
        this.lazyInit = false
        const flowIn = new Rete.Input(key, '', flowSocket, false)
        node.addInput(flowIn)
        return flowIn
    }

    addFlowOut(node: Node, key = 'fout'): Output {
        this.flowOut = true
        const flowOut = new Rete.Output(key, '', flowSocket, false)
        node.addOutput(flowOut)
        return flowOut
    }

    addFlowInOut(node: Node) {
        this.addFlowIn(node)
        this.addFlowOut(node)
    }

    // writer

    constructDas(node: Node, ctx: ConstructDasCtx): void {
        ctx.addProcessedNode(node)
        this.constructDasNode(node, ctx)
        if (this.flowOut)
            LangComponent.constructDasFlowOut(node, ctx)
    }


    getInputArgName(node, name, input, ctx): string {
        return ctx.nodeId(input)
    }


    abstract constructDasNode(node: Node, ctx: ConstructDasCtx): void


    static constructOptionalInNode(node: Node, name: string, ctx: ConstructDasCtx): Node | null {
        const inValue = node.inputs.get(name)
        if (!inValue || inValue.connections.length == 0) {
            return null
        }
        const inNode = inValue.connections[0].output.node
        if (!inNode) {
            return null
        }

        const component = <LangComponent>ctx.editor.components.get(inNode.name)
        return component.initOptionalInNode(inNode, node, name, ctx)
    }

    initOptionalInNode(node: Node, parentNode: Node, name: string, ctx: ConstructDasCtx): Node | null {
        LangComponent.constructAutoInit(node, ctx)
        ctx.reqNode(node)
        return node
    }


    static constructInNode(node: Node, name: string, ctx: ConstructDasCtx): Node | null {
        const inNode = LangComponent.constructOptionalInNode(node, name, ctx)
        if (!inNode)
            ctx.addError(node, 'input expected')
        return inNode
    }


    protected static constructAutoInit(node: Node, ctx: ConstructDasCtx) {
        if (ctx.isLazyInited(node))
            return
        const component = <LangComponent>ctx.editor.components.get(node.name)
        if (!component.lazyInit) // when flowIn exists -> for right order of constructDasNode in constructDasFlowOut and constructInNode
            return
        ctx.setIsLazyInit(node)
        component.constructDas(node, ctx)
    }


    static constructDasFlowOut(node: Node, ctx: ConstructDasCtx, key = 'fout'): boolean {
        const out = node.outputs.get(key)
        if (!out || out.connections.length == 0)
            return false
        const nextNode = out.connections[0].input.node
        if (!nextNode)
            return false
        const component = <LangComponent>ctx.editor.components.get(nextNode.name)
        component.initDasFlowOut(nextNode, out, ctx)
        return true
    }

    initDasFlowOut(node: Node, out: Output, ctx: ConstructDasCtx) {
        const component = <LangComponent>ctx.editor.components.get(node.name)
        component.constructDas(node, ctx)
    }
}


export class TypeCtor extends LangComponent {
    private readonly baseType: LangType
    private readonly useLocal: boolean

    constructor(name: string, group: string[], type: LangType) {
        super(name, group)
        this.baseType = type
        this.useLocal = this.baseType.desc.isLocal ?? false
    }

    async builder(node) {
        const out = new Rete.Output('result', 'Result', this.baseType.getSocket(), this.useLocal)
        node.addOutput(out)
        const inputControl = new TextInputControl(this.editor, 'value')
        inputControl.validator = this.baseType.validator
        inputControl.defaultValue = this.baseType.desc.default ?? ""
        node.data['value'] ??= this.baseType.desc.default
        node.addControl(inputControl)
    }

    worker(node, inputs, outputs) {
        const ctorArgs: { [key: string]: string } = {}
        const nodeRef = this.editor?.nodes.find(n => n.id == node.id)
        if (nodeRef) {
            const valueInput = <TextInputControl>nodeRef.controls.get('value')
            if (valueInput && valueInput.values != this.baseType.desc.enum) {
                valueInput.values = this.baseType.desc.enum
                valueInput.setValue(node.data['value'])
            }
        }

        outputs['result'] = this.baseType.ctor(inputs.value?.length ? inputs.value : node.data.value, ctorArgs)
    }

    constructDasNode(node, ctx): void {
        const ctorArgs: { [key: string]: string } = {}

        for (const req of this.baseType.desc.requirements ?? [])
            ctx.addReqModule(req)

        const val = this.baseType.ctor(node.data.value, ctorArgs)

        let outConnectionsNum = node.outputs.get('result')?.connections.length ?? 0
        const firstOutNode = node.outputs.get('result').connections[0].input.node

        if (!(outConnectionsNum == 1 && firstOutNode.name == "Function")) {
            if (this.useLocal && (!optimizeFlow || outConnectionsNum > 1))
                ctx.writeLine(node, `let ${ctx.nodeId(node)} = ${val}`)
            else
                ctx.setNodeRes(node, val)
        }
    }
}


export class LangFunc extends LangComponent {
    private readonly resType: LangType
    private readonly ctorFn: LangFunction
    private readonly useLocal: boolean
    private readonly langCtx: LangCtx

    constructor(name: string, group: string[], ctorFn: LangFunction, type: LangType, langCtx: LangCtx) {
        super(name, group)
        this.resType = type
        this.ctorFn = ctorFn
        this.langCtx = langCtx
        this.useLocal = this.resType.desc.isLocal ?? false
    }

    async builder(node) {
        if (!this.resType.isVoid) {
            const out = new Rete.Output('result', 'Result', this.resType.getSocket(), this.useLocal)
            node.addOutput(out)
        }
        if (this.ctorFn.desc.sideeffect)
            this.addFlowInOut(node)
        for (const field of this.ctorFn.desc.args) {
            const fieldType = this.langCtx.getType(field.mn)
            if (!fieldType) {
                console.error(`type ${field.mn} not found`)
                continue
            }
            node.data[field.name] ??= fieldType.desc.default
            const fieldInput = new Rete.Input(field.name, field.name, fieldType.getSocket(), false)
            if (fieldType.supportTextInput()) {
                const inputControl = new TextInputControl(this.editor, field.name)
                inputControl.validator = fieldType.validator
                inputControl.defaultValue = fieldType.desc.default ?? ""
                fieldInput.addControl(inputControl)
            }
            node.addInput(fieldInput)
        }
    }

    worker(node, inputs, outputs) {
        const nodeRef = this.editor?.nodes.find(n => n.id == node.id)
        if (nodeRef) {
            for (const field of this.ctorFn.desc.args) {
                const fieldInput = nodeRef.inputs.get(field.name)
                const inputControl = <TextInputControl>fieldInput?.control
                if (!inputControl)
                    continue
                const fieldType = this.langCtx.getType(field.mn)
                if (inputControl.values != fieldType!.desc.enum) {
                    inputControl.values = fieldType!.desc.enum
                    inputControl.setValue(node.data[field.name])
                }
            }
        }
        // if (!this.resType.isVoid) {
        //     const ctorArgs: { [key: string]: string } = {}
        //     for (const field of this.ctorFn.desc.args)
        //         ctorArgs[field.name] = inputs[field.name]?.length ? inputs[field.name] : node.data[field.name]
        //
        //     outputs['result'] = this.ctorFn.ctor(ctorArgs)
        // }
    }

    constructDasNode(node, ctx) {
        const ctorArgs: { [key: string]: string } = {}
        for (const field of this.ctorFn.desc.args) {
            const fieldType = this.langCtx.getType(field.mn)
            if (!fieldType) {
                console.error(`type ${field.mn} not found`)
                continue
            }
            const input = fieldType.supportTextInput() ? LangComponent.constructOptionalInNode(node, field.name, ctx) : LangComponent.constructInNode(node, field.name, ctx)
            if (input) {
                const component = <LangComponent>ctx.editor.components.get(input.name)
                ctorArgs[field.name] = component.getInputArgName(node, field.name, input, ctx)
                continue
            }

            for (const req of fieldType.desc.requirements ?? [])
                ctx.addReqModule(req)
            if (this.ctorFn.desc.args.length != 1 || fieldType.desc.typeName != this.ctorFn.desc.name) {
                ctorArgs[field.name] = fieldType.ctor(node.data[field.name], {}) ?? node.data[field.name]
                continue
            }
            ctorArgs[field.name] = fieldType.ctor(node.data[field.name], {}) ?? node.data[field.name]
        }
        for (const req of this.resType.desc.requirements ?? [])
            ctx.addReqModule(req)
        for (const req of this.ctorFn.desc.requirements ?? [])
            ctx.addReqModule(req)

        const val = this.ctorFn.ctor(ctorArgs)
        const outConnectionsNum = node.outputs.get('result')?.connections.length ?? 0
        if (this.useLocal && (!optimizeFlow || this.ctorFn.desc.sideeffect || outConnectionsNum > 1)) {
            if (this.resType.isVoid || outConnectionsNum == 0)
                ctx.writeLine(node, val)
            else
                ctx.writeLine(node, `let ${ctx.nodeId(node)} = ${val}`)
        } else
            ctx.setNodeRes(node, val)
    }
}


export class InputFlowComponent extends LangComponent {
    constructor() {
        super("InputFlow")
        // @ts-ignore
        this.module = {
            nodeType: 'input',
            socket: flowSocket
        }
    }

    async builder(node) {
        this.addFlowOut(node, 'output')
        node.addControl(new LabelControl(this.editor, 'name'))
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        console.assert()
    }
}


export class InputComponent extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super("Input")
        this.langCtx = langCtx
        // @ts-ignore
        this.module = {
            nodeType: 'input',
            socket(node) {
                return (node.data.typeName ? langCtx.getType(node.data.typeName) ?? langCtx.anyType : langCtx.anyType).getSocket()
            }
        }
    }

    async builder(node) {
        node.addControl(new LabelControl(this.editor, 'name'))
        node.addControl(new LangTypeSelectControl(this.editor, 'typeName', this.langCtx.allTypes))

        const type = node.data.typeName ? this.langCtx.getType(node.data.typeName) ?? this.langCtx.anyType : this.langCtx.anyType
        node.addOutput(new Rete.Output('output', "Value", type.getSocket()))
    }

    worker(node, inputs, outputs) {
        const nodeRef = this.editor?.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return

        let inType = this.langCtx.getType(node.data.typeName) ?? this.langCtx.anyType

        let updateNode = false
        const result = nodeRef.outputs.get('output')
        if (result) {
            const prevSocket = result.socket
            result.socket = (inType ?? this.langCtx.anyType).getSocket()
            if (prevSocket != result.socket) {
                for (const connection of [...result.connections]) {
                    if (!connection.output.socket.compatibleWith(connection.input.socket))
                        this.editor?.removeConnection(connection)
                }
                updateNode = true
            }
            node.data.typeName = (<LangSocket>result.socket).typeName
        }
        if (updateNode)
            nodeRef.update()
    }

    initOptionalInNode(node: Node, parentNode: Node, name: string, ctx: ConstructDasCtx): Node | null {
        let parentModule = ctx.currentModule
        if (parentModule == null) {
            ctx.addError(node, 'Input node is not in module')
            return null
        }

        ctx.endModule()
        let nextNode = LangComponent.constructOptionalInNode(parentModule, `${node.data.name}`, ctx)
        ctx.startModule(parentModule)
        return nextNode
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        console.assert()
    }
}


export class OutputFlowComponent extends LangComponent {
    public parentNode: Node | undefined

    constructor() {
        super("OutputFlow")
        // @ts-ignore
        this.module = {
            nodeType: 'output',
            socket: flowSocket
        }
    }

    async builder(node) {
        this.addFlowIn(node, 'input')
        node.addControl(new LabelControl(this.editor, 'name'))
    }

    initDasFlowOut(node: Node, out: Output, ctx: ConstructDasCtx): void {
        let parentModule = ctx.currentModule
        if (parentModule == null) {
            ctx.addError(node, 'OutputFlow node is not in module')
            return
        }

        ctx.endModule()
        LangComponent.constructDasFlowOut(parentModule, ctx, `${node.data.name}`)
        ctx.startModule(parentModule)
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        console.assert()
    }
}


export class OutputComponent extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super("Output")
        this.langCtx = langCtx
        // @ts-ignore
        this.module = {
            nodeType: 'output',
            socket(node) {
                return (node.data.typeName ? langCtx.getType(node.data.typeName) ?? langCtx.anyType : langCtx.anyType).getSocket()
            }
        }
    }

    async builder(node) {
        node.addControl(new LabelControl(this.editor, 'name'))

        const type = node.data.typeName ? this.langCtx.getType(node.data.typeName) ?? this.langCtx.anyType : this.langCtx.anyType
        node.addInput(new Rete.Input('input', "Value", type.getSocket(), false))
    }

    worker(node, inputs, outputs) {
        const nodeRef = this.editor?.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return
        const input = nodeRef.inputs.get('input')
        let prevSocket: Socket | undefined

        let inType: LangType | undefined
        if (input) {
            if (input.hasConnection()) {
                const connection = input.connections[0]
                inType = this.langCtx.getType((<LangSocket>connection.output.socket).typeName)
                if (inType && !inType.desc.isLocal && !inType.isAny) {
                    inType = this.langCtx.anyType
                    this.editor?.removeConnection(connection)
                }
            } else {
                inType = this.langCtx.anyType
            }

            prevSocket = input.socket

            input.socket = (inType ?? this.langCtx.anyType).getSocket()
            node.data.typeName = (<LangSocket>input.socket).typeName
        }
        if (prevSocket != input?.socket)
            nodeRef.update()
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        console.assert()
    }
}


export class ModuleComponent extends LangComponent {  //TODO: for initialized nodes in modules: node_id + current module_id
    constructor() {
        super("Module")
        // @ts-ignore
        this.module = {
            nodeType: 'module'
        }
    }

    async builder(node) {
        let ctrl = new ComboBoxControl(this.editor, 'module', ["", "./firstModule.dasflow", "./secondModule.dasflow"]) //TODO:
        ctrl.component.methods.onChange = () => {
            this.updateModuleSockets(node)
            node.update()
        }
        node.addControl(ctrl)
    }

    updateModuleSockets(node) { console.assert() }

    initOptionalInNode(node: Node, parentNode: Node, name: string, ctx: ConstructDasCtx): Node | null {
        const inValue = parentNode.inputs.get(name)
        if (!inValue || inValue.connections.length == 0) {
            return null
        }

        let outputName = inValue.connections[0].output.name

        let nodes = ctx.getModuleNodes.call(ctx.ctx, node.data.module)
        let outputNode = nodes.find((item) => item.name == 'Output' && item.data.name == outputName)

        ctx.startModule(node)
        let nextNode = LangComponent.constructOptionalInNode(outputNode, `input`, ctx)

        ctx.endModule()
        return nextNode
    }

    initDasFlowOut(node: Node, out: Output, ctx: ConstructDasCtx): void {
        let inputKey = out.connections[0].input.key

        let nodes = ctx.getModuleNodes.call(ctx.ctx, node.data.module)
        let inputFlowNode = nodes.find((item) => item.name == 'InputFlow' && item.data.name == inputKey)

        ctx.startModule(node)
        LangComponent.constructDasFlowOut(inputFlowNode, ctx, 'output')

        ctx.endModule()
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        console.assert()
    }
}


export class If extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super('If')
        this.langCtx = langCtx
    }

    async builder(node) {
        this.addFlowInOut(node)
        const onTrue = this.addFlowOut(node, 'then')
        onTrue.name = 'then'
        const onFalse = this.addFlowOut(node, 'else')
        onFalse.name = 'else'
        const input = new Rete.Input('inValue', 'Condition', this.langCtx.logicType.getSocket())
        node.addInput(input)
    }

    constructDasNode(node, ctx) {
        const inNode = LangComponent.constructInNode(node, 'inValue', ctx)
        if (!inNode)
            return false

        const component = <LangComponent>ctx.editor.components.get(inNode.name)
        ctx.writeLine(node, `if (${component.getInputArgName(node, 'inValue', inNode, ctx)})`)

        const thenChildCtx = ctx.getChild()
        if (!LangComponent.constructDasFlowOut(node, thenChildCtx, 'then'))
            ctx.addError(node, 'then exit expected')
        ctx.closeChild(thenChildCtx)

        ctx.writeLine(node, "else")
        const elseChildCtx = ctx.getChild()

        if (LangComponent.constructDasFlowOut(node, elseChildCtx, 'else'))
            ctx.closeChild(elseChildCtx)
        else
            ctx.writeLine(node, "\tpass")
    }
}


export class While extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super('While')
        this.langCtx = langCtx
    }

    async builder(node) {
        this.addFlowInOut(node)
        const body = this.addFlowOut(node, 'body')
        body.name = 'body'
        const input = new Rete.Input('inValue', 'Condition', this.langCtx.logicType.getSocket())
        node.addInput(input)
    }

    constructDasNode(node, ctx) {
        const inNode = LangComponent.constructInNode(node, 'inValue', ctx)
        if (!inNode)
            return

        const component = <LangComponent>ctx.editor.components.get(inNode.name)
        ctx.writeLine(node, `while (${component.getInputArgName(node, 'inValue', inNode, ctx)})`)

        const childCtx = ctx.getChild()
        if (LangComponent.constructDasFlowOut(node, childCtx, 'body'))
            ctx.closeChild(childCtx)
        else
            ctx.writeLine(node, '\tpass')
    }
}


export class For extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super('For')
        this.langCtx = langCtx
    }

    async builder(node) {
        this.addFlowInOut(node)
        const body = this.addFlowOut(node, 'body')
        body.name = 'body'

        node.addControl(new NumControl(this.editor, 'numArgs'))

        const numArgs = node.data.numArgs ?? 1
        for (let i = 0; i < numArgs; i++) {
            this.addArgInput(node, i)
            this.addArgOutput(node, i)
        }
    }

    private addArgInput(node, i: number) {
        const argInput = new Rete.Input(`range${i}`, `Range ${i + 1}`, this.langCtx.anyType.getSocket(), false)
        node.addInput(argInput)
    }

    private addArgOutput(node, i: number) {
        const type = node.data[`typeName${i}`] ? this.langCtx.getType(node.data[`typeName${i}`]) ?? this.langCtx.anyType : this.langCtx.anyType
        const argOutput = new Rete.Output(`val${i}`, `Value ${i + 1}`, type.getSocket(), true)
        node.addOutput(argOutput)
    }

    private getInType(node, argInput) {
        let inType: LangType | undefined
        if (argInput) {
            if (!argInput.hasConnection()) {
                inType = this.langCtx.anyType
            } else {
                const connection = argInput.connections[0]
                let connectedInType = this.langCtx.getType((<LangSocket>connection.output.socket).typeName)
                if (connectedInType && !connectedInType.desc.isLocal && !connectedInType.isAny || connectedInType && !connectedInType.isIterable) {
                    inType = this.langCtx.anyType
                    this.editor?.removeConnection(connection)
                } else {
                    const connectedInput = connection.output.node.inputs.get("arg0") //TODO: maybe works only with primitive range types
                    inType = this.langCtx.getType((<LangSocket>connectedInput.socket).typeName ?? this.langCtx.anyType)
                }
            }
        }
        return inType
    }

    private setOutType(node, inType, nodeRef, i: number) {
        const result = nodeRef.outputs.get(`val${i}`)
            if (result) {
                const prevSocket = result.socket
                result.socket = (inType ?? this.langCtx.anyType).getSocket()
                if (prevSocket != result.socket) {
                    for (const connection of [...result.connections]) {
                        if (!connection.output.socket.compatibleWith(connection.input.socket))
                            this.editor?.removeConnection(connection)
                    }
                }
                node.data[`typeName${i}`] = (<LangSocket>result.socket).typeName
            }
    }

    private controleNumArgs(node, nodeRef, numArgs, reqNumArgs) {
        if (!this.editor)
            return false

        if (numArgs < reqNumArgs) {
            for (let i = numArgs; i < reqNumArgs; i++) {
                this.addArgInput(nodeRef, i)
                this.addArgOutput(nodeRef, i)
                node.data[`typeName${i}`] = this.langCtx.anyType.getSocket().typeName
            }
            return true
        } else if (numArgs > reqNumArgs) {
            for (let i = reqNumArgs; i < numArgs; i++) {
                const argInput = nodeRef.inputs.get(`range${i}`)
                if (argInput) {
                    for (const conn of [...argInput.connections])
                        this.editor.removeConnection(conn)
                    nodeRef.removeInput(argInput)
                }
                const argOutput = nodeRef.outputs.get(`val${i}`)
                if (argOutput) {
                    for (const conn of [...argOutput.connections])
                        this.editor.removeConnection(conn)
                    nodeRef.removeOutput(argOutput)
                }
                delete node.data[`typeName${i}`]
            }
            return true
        }
        return false
    }

    worker(node, inputs, outputs) {
        if (!this.editor)
            return
        const nodeRef = this.editor.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return
        let updateNode = false
        const reqNumArgs = node.data.numArgs ?? 1
        outputs['numArgs'] = reqNumArgs
        const argsInput = <NumControl>nodeRef.controls.get('numArgs')
        if (argsInput)
            argsInput.setValue(reqNumArgs)
        const numArgs = Math.max(0, nodeRef?.inputs.size - 1 ?? 0 - 1)

        updateNode = this.controleNumArgs(node, nodeRef, numArgs, reqNumArgs)

        for (let i = 0; i < reqNumArgs; i++) {
            let inType: LangType | undefined
            const argInput = nodeRef.inputs.get(`range${i}`)
            inType = this.getInType(node, argInput)

            this.setOutType(node, inType, nodeRef, i)
            updateNode = true
        }
        if (updateNode)
            nodeRef.update()
    }

    getInputArgName(node, argName, inNode, ctx): string {
        let inValue = node.inputs.get(argName)
        let i = inValue.connections[0].output.key[3]
        return `x${i}${ctx.nodeId(inNode)}`
    }

    constructDasNode(node, ctx) {
        let index_part = 'for '
        let range_part = ' in '

        let isRangeExists = false

        for (let i = 0; i < node.inputs.size - 1; i++) {
            const inNode = LangComponent.constructInNode(node, `range${i}`, ctx)
            if (!inNode)
                continue

            isRangeExists = true

            index_part += `x${i}_${node.id}, `
            const component = <LangComponent>ctx.editor.components.get(inNode.name)
            range_part += `${component.getInputArgName(node, `range${i}`, inNode, ctx)}, `
        }

        if (!isRangeExists)
            return

        ctx.writeLine(node, index_part.slice(0, -2) + range_part.slice(0, -2))

        const childCtx = ctx.getChild()
        if (LangComponent.constructDasFlowOut(node, childCtx, 'body'))
            ctx.closeChild(childCtx)
        else
            ctx.writeLine(node, '\tpass')
    }
}


export class Function extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super('Function')
        this.langCtx = langCtx
        this._topLevel = true
    }

    async builder(node) {
        this.addFlowOut(node)

        node.addControl(new CheckBoxControl(this.editor, 'mainFuncMark', 'Main', false))

        node.addControl(new AutocomplitComboBoxControl(this.editor, 'annotation', this.langCtx.allFuncAnnotations))

        node.addControl(new LabelControl(this.editor, 'name'))

        node.addControl(new NumControl(this.editor, 'numArgs'))

        const numArgs = node.data.numArgs ?? 0
        for (let i = 0; i < numArgs; i++) {
            this.addArgInput(node, i)
            this.addArgOutput(node, i)
        }
    }

    private addArgInput(node, i: number) {
        const argInput = new Rete.Input(`arg${i}`, `Argument ${i + 1}`, this.langCtx.anyType.getSocket(), false)
        argInput.addControl(new LangTypeSelectControl(this.editor, `typeName${i}`, this.langCtx.allTypes))
        node.addInput(argInput)
    }

    private addArgOutput(node, i: number) {
        const type = node.data[`typeName${i}`] ? this.langCtx.getType(node.data[`typeName${i}`]) ?? this.langCtx.anyType : this.langCtx.anyType
        const argOutput = new Rete.Output(`out${i}`, `Output ${i + 1}`, type.getSocket(), true)
        node.addOutput(argOutput)
    }

    private getInType(node, argInput) {
        let inType: LangType | undefined
        if (argInput) {
            if (argInput.showControl()) {
                const argControl = <LangTypeSelectControl>argInput.control
                if (argControl.vueContext !== undefined) {
                    const controlVal = argControl.getValue()
                    inType = this.langCtx.allTypes.get(controlVal)
                } else {
                    inType = this.langCtx.anyType
                }
            } else {
                const connection = argInput.connections[0]
                inType = this.langCtx.getType((<LangSocket>connection.output.socket).typeName)
                if (inType && !inType.desc.isLocal && !inType.isAny) {
                    inType = this.langCtx.anyType
                    this.editor?.removeConnection(connection)
                }
            }
        }
        return inType
    }

    private setOutType(node, inType, nodeRef, i: number) {
        const result = nodeRef.outputs.get(`out${i}`)
            if (result) {
                const prevSocket = result.socket
                result.socket = (inType ?? this.langCtx.anyType).getSocket()
                if (prevSocket != result.socket) {
                    for (const connection of [...result.connections]) {
                        if (!connection.output.socket.compatibleWith(connection.input.socket))
                            this.editor?.removeConnection(connection)
                    }
                }
                node.data[`typeName${i}`] = (<LangSocket>result.socket).typeName
            }
    }

    private controleNumArgs(node, nodeRef, numArgs, reqNumArgs) {
        if (!this.editor)
            return false

        if (numArgs < reqNumArgs) {
            for (let i = numArgs; i < reqNumArgs; i++) {
                this.addArgInput(nodeRef, i)
                this.addArgOutput(nodeRef, i)
                node.data[`typeName${i}`] = this.langCtx.anyType.getSocket().typeName
            }
            return true
        } else if (numArgs > reqNumArgs) {
            for (let i = reqNumArgs; i < numArgs; i++) {
                const argInput = nodeRef.inputs.get(`arg${i}`)
                if (argInput) {
                    for (const conn of [...argInput.connections])
                        this.editor.removeConnection(conn)
                    nodeRef.removeInput(argInput)
                }
                const argOutput = nodeRef.outputs.get(`out${i}`)
                if (argOutput) {
                    for (const conn of [...argOutput.connections])
                        this.editor.removeConnection(conn)
                    nodeRef.removeOutput(argOutput)
                }
                delete node.data[`typeName${i}`]
            }
            return true
        }
        return false
    }

    worker(node, inputs, outputs) {
        if (!this.editor)
            return
        const nodeRef = this.editor.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return
        let updateNode = false
        const reqNumArgs = node.data.numArgs ?? 0
        outputs['numArgs'] = reqNumArgs
        const argsInput = <NumControl>nodeRef.controls.get('numArgs')
        if (argsInput)
            argsInput.setValue(reqNumArgs)
        const numArgs = Math.max(0, nodeRef?.inputs.size ?? 0 - 1)

        updateNode = this.controleNumArgs(node, nodeRef, numArgs, reqNumArgs)

        for (let i = 0; i < reqNumArgs; i++) {
            let inType: LangType | undefined
            const argInput = nodeRef.inputs.get(`arg${i}`)
            inType = this.getInType(node, argInput)

            this.setOutType(node, inType, nodeRef, i)
            updateNode = true
        }
        if (updateNode)
            nodeRef.update()
    }

    getInputArgName(node, argName, inNode, ctx): string {
        let inValue = node.inputs.get(argName)
        let i = inValue.connections[0].output.key[3]
        return `${ctx.nodeId(inNode)}_${i}`
    }

    initOptionalInNode(node: Node, parentNode: Node, name: string, ctx: ConstructDasCtx): Node | null {
        const inValue = parentNode.inputs.get(name)
        if (!inValue || inValue.connections.length == 0) {
            return null
        }

        const i = inValue.connections[0].output.key[3];
        const inChildNode = LangComponent.constructOptionalInNode(node, `arg${i}`, ctx)
        return inChildNode == null ? node : inChildNode
    }

    constructDas(node, ctx): void {
        let args = new Array<string>()
        const numArgs = node.data.numArgs ?? 0
        const argNames = new Set<string>()
        for (let i = 0; i < numArgs; i++) {
            let inNode = LangComponent.constructOptionalInNode(node, `arg${i}`, ctx)

            if (!inNode) {
                const inType = this.langCtx.getType(<string>node.data[`typeName${i}`])
                if (inType)
                    args.push(`${ctx.nodeId(node)}_${i}: ${inType.desc.typeName}`)
                else
                    args.push(`${ctx.nodeId(node)}_${i}`)

                continue // constructInNode adds an error
            }

            let childStr

            const component = <LangComponent>ctx.editor.components.get(inNode.name)
            if (!(component instanceof TypeCtor))
                ctx.addError(node, `Unsupported argument type: ${inNode.name}`)

            const argName = component.getInputArgName(node, `arg${i}`, inNode, ctx)
            if (argNames.has(argName))
                ctx.addError(node, `Duplicate argument name: ${argName}`)
            argNames.add(argName)

            const connectionsNum = inNode.outputs.get(`result`)?.connections.length ?? 0
            if (connectionsNum > 1) {
                childStr = `${argName}`
            } else {
                const argInput = this.editor?.nodes.find(it => it.id == node.id)?.inputs.get(`arg${i}`)
                if (!argInput)
                    continue

                const connection = argInput.connections[0]
                const type = this.langCtx.getType((<LangSocket>connection.output.socket).typeName)

                if (type) {
                    const ctorArgs: { [key: string]: string } = {}
                    const string_value = String(inNode.data.value)

                    const val = type.ctor(string_value, ctorArgs)
                    childStr = `${argName} = ${val}`
                }
            }

            args.push(childStr)
        }

        if (node.data.mainFuncMark !== undefined)
            if(node.data.mainFuncMark)
                ctx.setMainFunc(node.data.name)

        ctx.writeLine(node, `[${node.data.annotation}]\ndef ${node.data.name}(${args.join('; ')})`)
        const childCtx = ctx.getChild()
        if (LangComponent.constructDasFlowOut(node, childCtx))
            ctx.closeChild(childCtx)
        else
            ctx.writeLine(node, "\tpass")
        ctx.writeLine(node, "")
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
    }
}


export class Var extends LangComponent {
    protected readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super('Variable')
        this.langCtx = langCtx
    }

    async builder(node) {
        const type = node.data.typeName ? this.langCtx.getType(node.data.typeName) ?? this.langCtx.anyType : this.langCtx.anyType
        const out = new Rete.Output('result', 'Result', type.getSocket(), true)
        node.addOutput(out)
        node.addControl(new LangTypeSelectControl(this.editor, 'typeName', this.langCtx.allTypes))
    }

    worker(node, inputs, outputs) {
        const nodeRef = this.editor?.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return
        let inType = this.langCtx.getType(node.data.typeName) ?? this.langCtx.anyType

        const result = nodeRef.outputs.get('result')
        if (result) {
            const prevSocket = result.socket
            result.socket = (inType ?? this.langCtx.anyType).getSocket()
            if (prevSocket != result.socket) {
                for (const connection of [...result.connections]) {
                    if (!connection.output.socket.compatibleWith(connection.input.socket))
                        this.editor?.removeConnection(connection)
                }
                nodeRef.update()
            }
            node.data.typeName = (<LangSocket>result.socket).typeName
        }
    }

    constructDasNode(node, ctx): void {
        ctx.writeLine(node, `var ${ctx.nodeId(node)}: ${this.langCtx.getType(<string>node.data.typeName)?.desc.typeName}`)
    }
}


export class SetValue extends LangComponent {
    private readonly langCtx: LangCtx

    constructor(langCtx: LangCtx) {
        super("Set")
        this.langCtx = langCtx
    }

    async builder(node) {
        this.addFlowInOut(node)

        node.addInput(new Rete.Input('inVariable', 'Variable', this.langCtx.anyType.getSocket()))

        const type = node.data.typeName ? this.langCtx.getType(node.data.typeName) ?? this.langCtx.anyType : this.langCtx.anyType
        node.addOutput(new Rete.Output('result', 'Result', type.getSocket(), true))

        const numArgs = node.data.numArgs ?? 0
        for (let i = 0; i < numArgs; i++) {
            this.addArgValue(node, type, i)
        }
    }

    private addArgValue(node, type, i: number) {
        const fieldInput = new Rete.Input(`inValue${i}`, `value${i}`, type.getSocket(), false)
        if (type.supportTextInput()) {
            const inputControl = new TextInputControl(this.editor, `value${i}`)
            // inputControl.validator = type.validator
            inputControl.defaultValue = type.desc.default ?? ""
            fieldInput.addControl(inputControl)
        }
        node.addInput(fieldInput)
        node.data[`value${i}`] ??= type.desc.default
    }

    private getInType(node, argInput) {
        let inType: LangType | undefined
        if (argInput) {
            if (!argInput.hasConnection()) {
                inType = this.langCtx.anyType
            } else {
                const connection = argInput.connections[0]
                inType = this.langCtx.getType((<LangSocket>connection.output.socket).typeName)
                if (inType && !inType.desc.isLocal && !inType.isAny) {
                    inType = this.langCtx.anyType
                    this.editor?.removeConnection(connection)
                }
            }
        }
        return inType
    }

    private setOutType(node, inType, nodeRef) {
        const result = nodeRef.outputs.get(`result`)
            if (result) {
                const prevSocket = result.socket
                result.socket = (inType ?? this.langCtx.anyType).getSocket()
                if (prevSocket != result.socket) {
                    for (const connection of [...result.connections]) {
                        if (!connection.output.socket.compatibleWith(connection.input.socket))
                            this.editor?.removeConnection(connection)
                    }
                }
                node.data[`typeName`] = (<LangSocket>result.socket).typeName
            }
    }

    private controleNumArgs(node, nodeRef, numArgs, reqNumArgs, inType) {
        if (!this.editor)
            return false

        if (numArgs < reqNumArgs) {
            for (let i = numArgs; i < reqNumArgs; i++) {
                this.addArgValue(nodeRef, inType, i)
            }
        } else { // if (numArgs > reqNumArgs)
            for (let i = reqNumArgs; i < numArgs; i++) {
                const argInput = nodeRef.inputs.get(`inValue${i}`)
                if (argInput) {
                    for (const conn of [...argInput.connections])
                        this.editor.removeConnection(conn)
                    nodeRef.removeInput(argInput)
                    delete node.data[`value${i}`]
                }
            }
        }
    }

    worker(node, inputs, outputs) {
        if (!this.editor)
            return
        const nodeRef = this.editor.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return
        let updateNode = false

        const argInput = nodeRef.inputs.get(`inVariable`)
        let inVariableType = this.getInType(node, argInput)
        this.setOutType(node, inVariableType, nodeRef)

        const numArgs = node.data.numArgs ?? 0
        let reqNumArgs : number

        if (argInput?.hasConnection())
            // reqNumArgs = argInput.connections[0].output.node?.name !== "Struct" ? 1 : -1
            reqNumArgs = 1
        else
            reqNumArgs = 0
        node.data.numArgs = reqNumArgs

        if (reqNumArgs !== numArgs) {
            this.controleNumArgs(node, nodeRef, numArgs, reqNumArgs, inVariableType)
            updateNode = true
        } else if (reqNumArgs === numArgs) {
            for (let i = 0; i < reqNumArgs; i++) {
                let fieldInput = nodeRef.inputs.get(`inValue${i}`)
                if (!fieldInput)
                    continue
                const prevSocket = fieldInput.socket

                inVariableType = inVariableType ?? this.langCtx.anyType
                fieldInput.socket = (inVariableType).getSocket()

                if (prevSocket != fieldInput.socket) {
                    let inputControl = <TextInputControl>fieldInput.control
                    // inputControl.validator = inVariableType.validator
                    inputControl.defaultValue = inVariableType.desc.default ?? ""
                    node.data[`value${i}`] = inVariableType.desc.default
                    inputControl.setValue(node.data[`value${i}`])

                    updateNode = true
                }
            }
        }

        if (updateNode)
            nodeRef.update()
    }

    initOptionalInNode(node: Node, parentNode: Node, name: string, ctx: ConstructDasCtx): Node | null {
        const inValue = parentNode.inputs.get(name)
        if (!inValue || inValue.connections.length == 0) {
            return null
        }

        const inChildNode = LangComponent.constructOptionalInNode(node, 'inVariable', ctx)
        return inChildNode
    }

    constructDasNode(node, ctx): void {
        const ctorArgs: { [key: string]: string } = {}

        const numArgs = node.data.numArgs ?? 0
        const inVariableNode = LangComponent.constructInNode(node, 'inVariable', ctx)
        if (!inVariableNode)
            return

        for (let i = 0; i < numArgs; i++) {
            let val : any
            const inValueNode = LangComponent.constructOptionalInNode(node, `inValue${i}`, ctx)
            if (inValueNode) {
                const component = <LangComponent>ctx.editor.components.get(inValueNode.name)
                val = component.getInputArgName(node, `inValue${i}`, inValueNode, ctx)
            } else {
                const fieldType = this.langCtx.getType(node.data.typeName)
                val = fieldType!.ctor(node.data[`value${i}`], ctorArgs)
            }
            ctx.writeLine(node, `${ctx.nodeId(inVariableNode)} = ${val}`)
        }
    }
}


export class InjectTopLevelCode extends LangComponent {
    constructor() {
        super('InjectTopLevelCode')
        this._topLevel = true
    }

    async builder(node) {
        this.addFlowOut(node)
        node.addControl(new MultilineLabelControl(this.editor, 'code'))
    }

    constructDas(node, ctx): void {
        if (node.data.code) {
            const code = <string>node.data.code
            for (let string of code.split("\n"))
                ctx.writeLine(node, string)
        }

        const childCtx = ctx.getChild()
        if (LangComponent.constructDasFlowOut(node, childCtx))
            ctx.closeChild(childCtx)
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
    }
}


export class InjectCode extends LangComponent {
    constructor() {
        super('InjectCode')
    }

    async builder(node) {
        this.addFlowInOut(node)
        node.addControl(new MultilineLabelControl(this.editor, 'code'))
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        if (node.data.code) {
            const code = <string>node.data.code
            for (let string of code.split("\n"))
                ctx.writeLine(node, string)
        }
    }
}


export class Sequence extends LangComponent {
    constructor() {
        super('Sequence')
    }

    async builder(node) {
        this.addFlowIn(node)
        node.addControl(new NumControl(this.editor, 'numExits'))
        const reqNumExits = node.data.numExits ?? 0
        for (let i = 0; i < reqNumExits; i++)
            Sequence.addOutput(node, i)
    }

    private static addOutput(node: Node, i: number) {
        const out = new Rete.Output(`out${i}`, `Output ${i + 1}`, flowSocket, false)
        node.addOutput(out)
    }

    worker(node, inputs, outputs) {
        if (!this.editor)
            return
        const nodeRef = this.editor.nodes.find(it => it.id == node.id)
        if (!nodeRef)
            return
        const reqNumExits = node.data.numExits ?? 0
        outputs['numExits'] = reqNumExits
        const exitsInput = <NumControl>nodeRef.controls.get('numExits')
        if (exitsInput)
            exitsInput.setValue(reqNumExits)
        const numExits = nodeRef?.outputs.size ?? 0 - 1
        if (numExits == reqNumExits)
            return
        if (numExits < reqNumExits) {
            for (let i = numExits; i < reqNumExits; i++)
                Sequence.addOutput(nodeRef, i)
            nodeRef.update()
        } else {
            for (let i = reqNumExits; i < numExits; i++) {
                const out = nodeRef.outputs.get(`out${i}`)
                if (out) {
                    for (const conn of [...out.connections])
                        this.editor.removeConnection(conn)
                    nodeRef.removeOutput(out)
                }
            }
            nodeRef.update()
        }
    }

    constructDasNode(node: Node, ctx: ConstructDasCtx): void {
        for (let i = 0; i < node.outputs.size; ++i)
            LangComponent.constructDasFlowOut(node, ctx, `out${i}`)
    }
}


export class ConstructDasCtx {
    get code(): string {
        return this._code;
    }

    get indenting(): string {
        return this._indenting;
    }

    get currentModule(): Node | null {
        const len = this._currentModule.length
        if (len == 0)
            return null
        return this._currentModule[len - 1]
    }

    startModule(node: Node) {
        this._currentModule.push(node)
    }

    endModule() {
        this._currentModule.pop()
    }

    readonly editor: NodeEditor
    private _indenting = ""
    private _code = ""
    errors = new Map<number, string[]>()
    globalErrors = ""
    private lazyInited = new Set<number>()
    private requirements = new Set<string>()

    private nodeResults = new Map<number, string>()
    private processedNodes = new Set<number>()
    private requiredNodes = new Set<number>()
    private lineToNode = new Map<number, number>()
    private linesCount = 3
    private mainFunctions = new Array<string>()

    private _currentModule: Node[] = []
    public ctx: any
    getModuleNodes(name) { console.assert() }

    constructor(editor: NodeEditor, outerFunc, ctx) {
        this.editor = editor
        this.getModuleNodes = outerFunc
        this.ctx = ctx
    }

    getChild(extraIndent = '\t'): ConstructDasCtx {
        let res = new ConstructDasCtx(this.editor, this.getModuleNodes, this.ctx)
        res._indenting = this._indenting + extraIndent
        res.errors = this.errors
        res.lazyInited = this.lazyInited
        res.requirements = this.requirements
        res.nodeResults = this.nodeResults
        res.processedNodes = this.processedNodes
        res.requiredNodes = this.requiredNodes
        res._currentModule = this._currentModule
        return res
    }

    setMainFunc(name: string) {
        this.mainFunctions.push(name)
    }

    getMainFunc() {
        console.log(this.mainFunctions)
        return this.mainFunctions[0]
    }

    getGlobalErrors() {
        return this.globalErrors
    }

    writeLine(node: Node, str: string): void {
        this._code += `${this._indenting}${str}\n`
        this.lineToNode.set(node.id, this.linesCount)
        this.linesCount += str.split('\n').length
    }

    addError(node: Node, msg: string): boolean {
        this.writeLine(node, `//ERROR: node error here, code discarded`)
        return this.addErrorId(node.id, msg)
    }

    addNativeErrors(errors: CompileError[], thisFile: string) {
         for (const error of errors) {
            const strFile = String(error.file.split('/').slice(-1))
            if (strFile == thisFile) {
                let isFound = false

                for (const [id, line] of this.lineToNode) {
                    if (line == error.line) {
                        this.addErrorId(id, error.message)
                        const node = this.editor.nodes.find(n => n.id == id)
                        const error_text = '\u00A0' + '\u00A0' + error.message  +
                                            (error.fixme == '' ? '' : '\nfixme: ' + error.fixme) +
                                            (error.extra == '' ? '' : '\nextra: ' + error.extra)
                        // @ts-ignore
                        this.editor?.trigger('addcomment', ({ type: 'inline', text: error_text, position: node.position }))
                        isFound = true
                        break
                    }
                }
                if (!isFound) {
                    this.addGlobalError(error.line, error.message)
                }
            }
        }
    }

    addGlobalError(line: number, msg: string) {
        const global_text = msg + ' in line ' + (line - 3).toString()
        console.log(global_text)
        this.globalErrors += global_text
    }

    private addErrorId(id: number, msg: string): boolean {
        if (!this.errors.has(id))
            this.errors.set(id, [msg])
        else {
            const data = this.errors.get(id)
            data?.push(msg)
        }
        return false
    }

    hasErrors() {
        return this.errors.size > 0
    }

    logErrors() {
        for (const [id, messages] of this.errors) {
            for (const node of this.editor.nodes) {
                if (node.id == id) {
                    // @ts-ignore
                    this.editor?.trigger('addcomment', ({ type: 'inline', text: '\u00A0' + messages, position: node.position }))
                    console.log(`Node ${node.name}:${node.id}\n\t${messages.join('\n\t')}`)
                    break
                }
            }
        }
    }

    nodeId(node: Node): string {
        if (this.nodeResults.has(node.id)) {
            return this.nodeResults.get(node.id)!
        } else {
            return `_${node.id}`
        }
    }

    isLazyInited(node: Node): boolean {
        return this.lazyInited.has(node.id)
    }

    setIsLazyInit(node: Node) {
        this.lazyInited.add(node.id)
    }

    addReqModule(module: string) { //TODO: move linesToNode
        this.requirements.add(module)
    }

    setNodeRes(node: Node, s: string) {
        this.nodeResults.set(node.id, s)
    }

    reqNode(node: Node) {
        this.requiredNodes.add(node.id)
    }

    addProcessedNode(node: Node) {
        this.processedNodes.add(node.id)
    }

    build() {
        if (this.requirements.size > 0)
            this._code = "\n\n" + this._code
        for (const req of this.requirements)
            this._code = `require ${req}\n` + this._code
        this.requirements.clear()
        for (const it of this.processedNodes)
            this.requiredNodes.delete(it)
        for (let requiredNode of this.requiredNodes) {
            this.addErrorId(requiredNode, "Node is not processed")
        }
    }

    closeChild(child: ConstructDasCtx) {
        this._code += child._code
    }
}
